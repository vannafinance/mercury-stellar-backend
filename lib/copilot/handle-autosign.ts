/**
 * Auto-sign enable/disable and wallet-bind prompts.
 *
 * Write execution stays in handle.ts. This is the control-plane peel so handle.ts
 * can stay near the 4,500-line P2 target.
 */

import { copilotConfig } from "./config";
import { factsForUi } from "./explain";
import { getMcpClient, type MCPClient } from "./mcp-client";
import {
  enableAutoSign,
  defaultCapUsdFromMcp,
} from "./mcp-write";
import {
  registerWalletBind,
  rememberConnectOrigin,
  resolveConnectOrigin,
  resolvePrivySignerId,
} from "./wallet-bind";
import type { ChatRequest, ChatResponse, CopilotAction } from "./types";

type ResumeWrite = (
  action: CopilotAction,
  ctx: {
    userId: string;
    trader: string | null;
    smartAccount: string | null;
    request_id: string;
    message: string;
  },
) => Promise<ChatResponse>;

let resumeWrite: ResumeWrite | null = null;

/** Wired from handle.ts so enabling auto-sign can resume a pending write without a cycle. */
export function bindAutoSignResume(write: ResumeWrite): void {
  resumeWrite = write;
}

// ── Auto-sign ─────────────────────────────────────────────────────────────

/**
 * Did the Sign Service refuse because this wallet is not bound to the caller?
 *
 * Matched on the error CODE first, because that is the contract MCP passes through
 * verbatim (`sign_tools._sign_service_request` forwards `wallet_not_bound` with its
 * http_status). The message sweep is a second net for the paths that flatten the
 * error into prose before it reaches here.
 */
function isWalletNotBound(r: Record<string, unknown> | null | undefined): boolean {
  if (!r) return false;
  if (String(r.error ?? "") === "wallet_not_bound") return true;
  const detail = r.detail as { error?: unknown } | undefined;
  if (detail && String(detail.error ?? "") === "wallet_not_bound") return true;
  return /wallet_not_bound/i.test(String(r.message ?? ""));
}

/**
 * Mint the additional-signer consent link and hand it to the user.
 *
 * `vanna_connect_wallet_start` carries the end-user assertion (it is not in
 * READ_ONLY_TOOLS), which is the entire point: the Sign Service stamps the
 * assertion's `sub` onto the pending connect request at /wallets/connect/start, and
 * that stored sub is what becomes the `identity_wallet_bindings` row when the user
 * finishes. Called without the assertion the flow still returns a working link and
 * still connects the wallet — and still writes no binding, so auto-sign keeps
 * failing with the same 403. A connect that cannot bind is the trap this replaces.
 *
 * `retry` is the user's original request, carried through the detour so it can be
 * replayed the moment the binding exists.
 */
async function startWalletBind(
  mcp: MCPClient,
  trader: string,
  userId: string,
  request_id: string,
  retry: {
    action?: "use_defaults" | "custom" | "disable" | null;
    max_per_tx_usd?: number | string | null;
    max_per_day_usd?: number | string | null;
  },
  /** Why we are here, in the user's terms — prepended to the instruction. May be "". */
  because: string,
): Promise<ChatResponse> {
  /** Join the optional preamble without leaving a leading space when there is none. */
  const lead = (rest: string) => (because ? `${because} ${rest}` : rest);
  let started: Record<string, unknown>;
  try {
    started = await mcp.call("vanna_connect_wallet_start", {}, userId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      kind: "needs_wallet_bind",
      message: lead(
        `Vanna needs your permission to sign for this wallet, but the consent link ` +
          `could not be created (${msg}). Nothing changed — every write still asks ` +
          `for your signature.`,
      ),
      wallet_bind: { status: "unavailable", wallet_address: trader },
      request_id,
    };
  }

  const connectUrl = typeof started.connect_url === "string" ? started.connect_url : null;
  if (!connectUrl || started.error) {
    // No link means no consent is possible right now. Say which hop refused rather
    // than implying the user can fix it by reconnecting their wallet again.
    const why = String(started.message || started.error || "no connect_url returned");
    return {
      kind: "needs_wallet_bind",
      message: lead(
        `Vanna needs your permission to sign for this wallet, but the signing service ` +
          `could not issue a consent link (${why}). Writes still work — they will ask ` +
          `for your signature each time.`,
      ),
      wallet_bind: { status: "unavailable", wallet_address: trader },
      data: factsForUi(started),
      request_id,
    };
  }

  const schedule = Array.isArray(started.poll_schedule_seconds)
    ? (started.poll_schedule_seconds as unknown[]).map(Number).filter((n) => Number.isFinite(n))
    : null;
  const startedRequestId =
    typeof started.request_id === "string" ? started.request_id : null;

  // Remember where this request was minted so `bind_register` can complete it
  // without ever being told a forward target by the browser.
  if (startedRequestId) rememberConnectOrigin(startedRequestId, connectUrl);

  // The signer the page must authorize. Its presence is what makes the consent
  // possible in-app; without it the client can only fall back to the link.
  const origin = startedRequestId ? resolveConnectOrigin(startedRequestId) : null;
  const signerId = origin ? await resolvePrivySignerId(origin) : null;

  return {
    kind: "needs_wallet_bind",
    message: lead(
      `Your wallet is connected, but Vanna is not yet authorized to sign for it — ` +
        `those are two separate permissions, which is why reconnecting your wallet ` +
        `does not fix it. Approving Vanna as an additional signer on your own wallet ` +
        `finishes it. You keep custody; Vanna is only added alongside your own key, ` +
        `and you can revoke it in Privy at any time. As soon as it is approved, ` +
        `${retry.action === "disable" ? "the change" : "auto-sign"} is applied ` +
        `automatically.`,
    ),
    wallet_bind: {
      status: "needs_consent",
      request_id: startedRequestId,
      connect_url: connectUrl,
      signer_id: signerId,
      expires_in: Number.isFinite(Number(started.expires_in))
        ? Number(started.expires_in)
        : null,
      poll_schedule_seconds: schedule?.length ? schedule : null,
      wallet_address: trader,
      retry_action: retry.action ?? null,
      max_per_tx_usd: retry.max_per_tx_usd ?? null,
      max_per_day_usd: retry.max_per_day_usd ?? null,
    },
    data: factsForUi(started),
    request_id,
  };
}

/**
 * Complete a consent the page has already obtained from Privy, then apply the enable.
 *
 * This is the normal path. By the time it runs, the browser has called `addSigners`
 * in the same gesture that turned auto-sign on, so all that remains is the register
 * hop it cannot make cross-origin (see lib/copilot/wallet-bind.ts) and the enable the
 * 403 originally blocked.
 *
 * It does NOT trust the browser's word that the consent happened. Register makes the
 * main Sign Service re-verify quorum-is-signer against Privy and write the binding,
 * and the enable that follows is the same gated call as ever — so a page that lied
 * about `addSigners` gets a `quorum_not_signer` refusal here, not a session.
 */
async function handleBindRegister(
  mcp: MCPClient,
  req: ChatRequest,
  request_id: string,
  trader: string,
  userId: string,
): Promise<ChatResponse> {
  const requestId = req.auto_sign?.request_id;
  const walletAddress = (req.auto_sign?.wallet_address || trader).trim();
  const retryAction = req.auto_sign?.retry_action ?? null;

  if (!requestId) {
    return {
      kind: "error",
      message: "Cannot complete the signing authorization without its request_id.",
      request_id,
    };
  }

  const origin = resolveConnectOrigin(requestId);
  if (!origin) {
    // The start hop's origin is gone (different instance, or expired). The link
    // fallback still completes the same consent, so offer that rather than fail.
    return {
      kind: "needs_wallet_bind",
      message:
        "The authorization could not be completed automatically. Finish it with the " +
        "link below and auto-sign will be applied as soon as you do.",
      wallet_bind: {
        status: "expired",
        wallet_address: walletAddress,
        retry_action: retryAction,
        max_per_tx_usd: req.auto_sign?.max_per_tx_usd ?? null,
        max_per_day_usd: req.auto_sign?.max_per_day_usd ?? null,
      },
      request_id,
    };
  }

  const registered = await registerWalletBind({ requestId, walletAddress, origin });
  if (!registered.ok) {
    // `already_used` means a concurrent poll or a second click already consumed the
    // request — the binding may well exist, so fall through to the status check
    // rather than reporting a failure the user would not recognise.
    if (registered.code !== "already_used") {
      // `origin_not_allowed` is the one failure here that is pure deployment config:
      // the Connect Gateway's CONNECT_ORIGIN_ALLOWLIST is set and does not include
      // this app. Naming it saves the next person the trace, because from the browser
      // it is indistinguishable from the consent itself having failed.
      const hint =
        registered.code === "origin_not_allowed"
          ? " (the wallet-authorization service is not configured to accept requests " +
            "from this app — CONNECT_ORIGIN_ALLOWLIST)"
          : "";
      return {
        kind: "needs_wallet_bind",
        message:
          `Vanna could not finish authorizing this wallet (${registered.message})${hint}. ` +
          `Nothing changed — writes still ask for your signature each time.` +
          (registered.expired ? " The authorization request expired; start it again." : ""),
        wallet_bind: {
          status: registered.expired ? "expired" : "unavailable",
          wallet_address: walletAddress,
          retry_action: retryAction,
          max_per_tx_usd: req.auto_sign?.max_per_tx_usd ?? null,
          max_per_day_usd: req.auto_sign?.max_per_day_usd ?? null,
        },
        request_id,
      };
    }
  }

  // Confirm with the Sign Service and apply the enable. Deliberately the SAME path a
  // fallback-link consent takes, so both routes converge on one verified outcome.
  return handleBindStatus(mcp, req, request_id, trader, userId);
}

/**
 * Poll a pending consent, and finish the user's original request when it lands.
 *
 * The retry is done here rather than left to the client on purpose. `connected` from
 * the connect flow means the quorum is now a signer on the wallet AND the binding row
 * was written — it does NOT mean auto-sign is on; that still needs a policy session,
 * which is the call that 403'd in the first place. Reporting "connected" and stopping
 * would leave the user exactly one unexplained step short of what they asked for,
 * looking at a success message and a still-broken toggle.
 *
 * A retry that fails is reported as itself: if `enable_auto_sign` still says
 * `wallet_not_bound` after a completed consent, that is a real bug and the message
 * says so instead of silently offering another link to click forever.
 */
async function handleBindStatus(
  mcp: MCPClient,
  req: ChatRequest,
  request_id: string,
  trader: string,
  userId: string,
): Promise<ChatResponse> {
  const pollId = req.auto_sign?.request_id;
  const retryAction = req.auto_sign?.retry_action ?? null;
  if (!pollId) {
    return {
      kind: "error",
      message: "Cannot check the signing-authority request without its request_id.",
      request_id,
    };
  }

  const st = await mcp.call("vanna_connect_wallet_status", { request_id: pollId }, userId);
  const status = String(st.status || "");

  if (status === "expired") {
    return {
      kind: "needs_wallet_bind",
      message:
        "That authorization link expired before it was completed. Start it again and " +
        "approve Vanna as an additional signer to finish enabling auto-sign.",
      wallet_bind: {
        status: "expired",
        wallet_address: trader,
        retry_action: retryAction,
        max_per_tx_usd: req.auto_sign?.max_per_tx_usd ?? null,
        max_per_day_usd: req.auto_sign?.max_per_day_usd ?? null,
      },
      data: factsForUi(st),
      request_id,
    };
  }

  if (status !== "connected") {
    return {
      kind: "needs_wallet_bind",
      message:
        "Still waiting for you to approve Vanna as an additional signer in the " +
        "authorization window.",
      wallet_bind: {
        status: "pending",
        request_id: pollId,
        wallet_address: trader,
        retry_action: retryAction,
        max_per_tx_usd: req.auto_sign?.max_per_tx_usd ?? null,
        max_per_day_usd: req.auto_sign?.max_per_day_usd ?? null,
      },
      data: factsForUi(st),
      request_id,
    };
  }

  // Bound. Finish what the user actually asked for.
  if (!retryAction) {
    return {
      kind: "answer",
      message:
        "Vanna is now authorized to sign for this wallet. Auto-sign is not on yet — " +
        "enable it with your spend limits when you want hands-free writes.",
      data: factsForUi(st),
      request_id,
    };
  }

  const retried = await handleAutoSignAction(
    {
      ...req,
      auto_sign: {
        action: retryAction,
        ...(req.auto_sign?.max_per_tx_usd != null
          ? { max_per_tx_usd: req.auto_sign.max_per_tx_usd }
          : {}),
        ...(req.auto_sign?.max_per_day_usd != null
          ? { max_per_day_usd: req.auto_sign.max_per_day_usd }
          : {}),
      },
    },
    request_id,
    trader,
    userId,
  );

  // A second wallet_not_bound after a completed consent is not a UX problem to loop
  // on — it means the binding did not land for the subject the assertion carries.
  if (retried.kind === "needs_wallet_bind") {
    return {
      ...retried,
      message:
        "You completed the authorization, but the signing service still reports this " +
        "wallet as unbound. That is a server-side fault, not something you can fix by " +
        "reconnecting — please report it. Writes still work with a signature each time.",
      wallet_bind: { ...(retried.wallet_bind ?? {}), status: "unavailable", wallet_address: trader },
    };
  }
  return retried;
}

export async function handleAutoSignAction(
  req: ChatRequest,
  request_id: string,
  trader: string | null,
  userId: string,
): Promise<ChatResponse> {
  if (!trader) {
    return {
      kind: "clarification",
      message: "Connect your Stellar wallet first, then enable auto-sign.",
      request_id,
    };
  }
  const mcp = getMcpClient();
  const action = req.auto_sign?.action || "start";

  try {
    // The user asked to bind, or is polling a bind they started. Both are the same
    // consent flow, entered explicitly rather than as a reaction to a 403.
    if (action === "bind_start") {
      return startWalletBind(
        mcp,
        trader,
        userId,
        request_id,
        { action: req.auto_sign?.retry_action ?? null },
        "",
      );
    }

    if (action === "bind_status") {
      return handleBindStatus(mcp, req, request_id, trader, userId);
    }

    if (action === "bind_register") {
      return handleBindRegister(mcp, req, request_id, trader, userId);
    }

    if (action === "status") {
      // Read-only. A silent poll on wallet connect must not mint a connect
      // request, open the bind UI, or create a session — it only tells the
      // Autonomy card whether GET /sessions is already enforcing.
      const r = await mcp.call("vanna_auto_sign_status", { wallet_address: trader }, userId);
      const tx = Number(r.max_per_tx_usd);
      const day = Number(r.max_per_day_usd);
      const enabled = r.enabled === true || r.status === "enabled";
      const facts = {
        ...factsForUi(r),
        enabled,
        status: r.status ?? (enabled ? "enabled" : "disabled"),
        max_per_tx_usd: Number.isFinite(tx) ? tx : r.max_per_tx_usd ?? null,
        max_per_day_usd: Number.isFinite(day) ? day : r.max_per_day_usd ?? null,
        session_id: r.session_id ?? null,
        error: r.error ?? null,
      };
      if (isWalletNotBound(r)) {
        return {
          kind: "answer",
          message:
            (r.summary as string) ||
            (r.message as string) ||
            "This wallet is connected but not bound for Vanna signing.",
          data: { ...facts, enabled: false, status: "unbound", error: "wallet_not_bound" },
          request_id,
        };
      }
      if (r.error) {
        return {
          kind: "error",
          message:
            (r.summary as string) ||
            (r.message as string) ||
            `Could not read auto-sign status (${String(r.error)}).`,
          data: facts,
          request_id,
        };
      }
      return {
        kind: "answer",
        message:
          (r.summary as string) ||
          (r.message as string) ||
          (enabled ? "Auto-sign is on." : "Auto-sign is off."),
        data: facts,
        request_id,
      };
    }

    if (action === "disable") {
      const r = await mcp.call("vanna_disable_auto_sign", { wallet_address: trader }, userId);
      // Revoking a server-side session is gated on the same binding as creating one,
      // so "turn this off" can 403 for a wallet that was never bound. The user's
      // in-app auto-approve toggle is client-side and the UI has already turned it
      // off; what needs the binding is reaching any session held at the Sign Service.
      if (isWalletNotBound(r)) {
        return startWalletBind(
          mcp,
          trader,
          userId,
          request_id,
          { action: "disable" },
          "Auto-approve is off in this browser.",
        );
      }
      return {
        kind: "answer",
        message: (r.summary as string) || (r.message as string) || "Auto-sign disabled.",
        data: factsForUi(r),
        request_id,
      };
    }

    if (action === "start") {
      // Bare call → MCP returns needs_confirmation with two options + default_cap_usd
      const r = await enableAutoSign(mcp, { wallet: trader, userId: userId || trader });
      const st = String(r.status || "");
      const defCap = defaultCapUsdFromMcp(r);
      // Ask for the missing consent BEFORE asking for spend caps. Caps chosen now
      // cannot be applied — the 403 lands before any session is created — so showing
      // the cap picker first collects an answer only to throw it away, and the user
      // reads the failure that follows as "my limits were rejected".
      if (isWalletNotBound(r)) {
        return startWalletBind(mcp, trader, userId, request_id, { action: "use_defaults" }, "");
      }
      if (st === "needs_confirmation" || !r.enabled) {
        return {
          kind: "needs_auto_sign",
          message:
            (r.question as string) ||
            (r.message as string) ||
            (r.summary as string) ||
            `Enable auto-approve / auto-sign. MCP default is $${defCap}/tx and $${defCap}/day ` +
              `(testnet stand-in; Sign Service may clamp). Pick defaults or custom USD caps.`,
          auto_sign: {
            status: "needs_confirmation",
            message: `Choose spend limits (MCP default_cap_usd=$${defCap}):`,
            options: [
              {
                id: "use_defaults",
                label: "Use defaults",
                description: `$${defCap} per transaction · $${defCap} per day (from MCP)`,
              },
              {
                id: "custom",
                label: "Set my own limits",
                description: "Choose per-tx and daily USD caps (day can differ from tx)",
              },
            ],
            pending_write: req.pending_write
              ? {
                  op: req.pending_write.op,
                  asset: req.pending_write.asset,
                  amount: req.pending_write.amount,
                  leverage: req.pending_write.leverage,
                }
              : null,
            raw: r,
          },
          data: factsForUi(r),
          request_id,
        };
      }
      return {
        kind: "answer",
        message: (r.summary as string) || "Auto-sign enabled.",
        data: factsForUi(r),
        request_id,
      };
    }

    if (action === "use_defaults") {
      // Only use_default_caps — do not also send max_per_tx_usd (MCP then applies SS defaults).
      const r = await enableAutoSign(mcp, {
        wallet: trader,
        userId: userId || trader,
        useDefaultCaps: true,
      });
      if (isWalletNotBound(r)) {
        return startWalletBind(mcp, trader, userId, request_id, { action: "use_defaults" }, "");
      }
      const defCap = defaultCapUsdFromMcp(r);
      const msg =
        (r.summary as string) ||
        (r.message as string) ||
        `Auto-sign / auto-approve enabled with MCP default caps (≈ $${defCap}/tx · $${defCap}/day).` +
          (r.error
            ? ` (MCP note: ${String(r.error)} — wallet session signing may still work for in-app approve.)`
            : "");
      // Resume pending write if any
      if (req.pending_write?.op && (r.status === "enabled" || r.enabled === true || !r.error)) {
        const resumed = await resumeWrite?.(
          {
            op: req.pending_write.op,
            asset: req.pending_write.asset ?? null,
            amount: req.pending_write.amount ?? null,
            leverage: req.pending_write.leverage ?? null,
            smart_account: req.smart_account ?? null,
            trader,
          },
          {
            userId,
            trader,
            smartAccount: req.smart_account ?? null,
            request_id,
            message: "resume after auto-sign",
          },
        );
        if (resumed?.kind === "executed") {
          return {
            ...resumed,
            message: `${msg}\n\n${resumed.message}`,
          };
        }
      }
      return {
        kind: r.error ? "error" : "answer",
        message: msg,
        data: factsForUi(r),
        request_id,
      };
    }

    if (action === "custom") {
      const tx = req.auto_sign?.max_per_tx_usd;
      if (tx == null || tx === "") {
        // Probe MCP for default_cap_usd so UI numbers are not invented.
        let defCap = 1000;
        try {
          const probe = await enableAutoSign(mcp, { wallet: trader, userId: userId || trader });
          // Same reason as the `start` branch: consent before caps, so the numbers the
          // user types are numbers we can actually apply.
          if (isWalletNotBound(probe)) {
            return startWalletBind(mcp, trader, userId, request_id, { action: "custom" }, "");
          }
          defCap = defaultCapUsdFromMcp(probe);
        } catch {
          /* keep fallback */
        }
        return {
          kind: "needs_auto_sign",
          message:
            "Set your auto-approve / auto-sign spend caps (same as MCP Sign Service).\n" +
            `MCP default_cap_usd is $${defCap} per tx and per day (you may set a higher day cap).\n` +
            "Pick defaults, enter custom USD limits, or say e.g. “set auto-sign cap to 500 per tx and 2000 per day”.",
          auto_sign: {
            status: "needs_confirmation",
            message: "Choose spend limits:",
            options: [
              {
                id: "use_defaults",
                label: "Use defaults",
                description: `$${defCap} per transaction · $${defCap} per day (MCP)`,
              },
              {
                id: "custom",
                label: "Set my own limits",
                description: "Per-tx required; daily optional (defaults to per-tx if omitted)",
              },
            ],
            pending_write: null,
            raw: null,
          },
          request_id,
        };
      }
      // If user only sets per-tx, omit day so MCP mirrors (sign_tools: day = tx).
      const dayRaw = req.auto_sign?.max_per_day_usd;
      const r = await enableAutoSign(mcp, {
        wallet: trader,
        userId: userId || trader,
        maxPerTxUsd: tx,
        ...(dayRaw != null && dayRaw !== "" ? { maxPerDayUsd: dayRaw } : {}),
      });
      if (isWalletNotBound(r)) {
        // Carry the caps through the consent detour so they are applied on the retry
        // and the user never re-enters them.
        return startWalletBind(
          mcp,
          trader,
          userId,
          request_id,
          { action: "custom", max_per_tx_usd: tx, max_per_day_usd: dayRaw ?? tx },
          "",
        );
      }
      const dayShown = dayRaw != null && dayRaw !== "" ? dayRaw : tx;
      return {
        kind: r.error ? "error" : "answer",
        message:
          (r.summary as string) ||
          (r.message as string) ||
          `Auto-sign / auto-approve enabled with your caps: $${tx} per tx · $${dayShown} per day.`,
        data: factsForUi({
          ...r,
          max_per_tx_usd: tx,
          max_per_day_usd: dayShown,
          default_cap_usd: defaultCapUsdFromMcp(r),
        }),
        request_id,
      };
    }
  } catch (e) {
    return {
      kind: "error",
      message: `Auto-sign failed: ${e instanceof Error ? e.message : String(e)}`,
      request_id,
    };
  }

  return { kind: "error", message: "Unknown auto-sign action.", request_id };
}


import { OrderBookRowType } from "@/components/spot/spot-orderbook/OrderBook";
import {
  ActivePositionType,
  OpenOrderType,
  OrderPlacementFormValues,
} from "./types";

export function mapOrderToActivePosition(
  order: OrderPlacementFormValues,
  currentPrice: number
): ActivePositionType {
  // TAKE PROFIT MAPPING
  let takeProfit: { label: string; value: number }[] | undefined = undefined;

  // Case 1: Multiple TP
  if (
    order.takeProfitEnabled &&
    order.multipleTpEnabled &&
    order.multipleTakeProfits?.length
  ) {
    takeProfit = order.multipleTakeProfits.map((tp, idx) => ({
      label: `Tp${idx + 1}`,
      value: tp.profitAmount ?? 0,
    }));
  }

  // Case 2: Single TP
  if (
    order.takeProfitEnabled &&
    !order.multipleTpEnabled &&
    order.singleTakeProfit?.profitAmount
  ) {
    takeProfit = [
      {
        label: "Tp1",
        value: order.singleTakeProfit.profitAmount,
      },
    ];
  }
  return {
    id: crypto.randomUUID(),

    dateTime: new Date().toISOString().replace("T", " ").slice(0, 19),

    pair: "BTC/USDT",

    type: order.orderType === "market" ? "Market" : "Limit",

    side: order.orderSide === "buy" ? "Buy" : "Sell",

    qty: `${order.totalUnits ?? 0} BTC`,

    estFilledPrice: `${currentPrice} USDT`,

    takeProfit,

    slTriggerPrice: order.stopLoss?.triggerPrice ?? undefined,
    slLimit: order.stopLoss?.limitPrice ?? undefined,

    trailPctOrUsd: order.stopLoss?.trailVariance
      ? `${order.stopLoss.trailVariance} ${order.stopLoss.trailVarianceUnit}`
      : undefined,

    loop: order.loopEnabled ? `${order.noOfLoops ?? "-"}` : undefined,

    currentPnlUsd: "+0",
    currentPnlPct: "0%",

    status: "Active",
  };
}

export function mapOrderToOpenOrder(
  order: OrderPlacementFormValues
): OpenOrderType {
  return {
    id: crypto.randomUUID(),

    dateTime: new Date().toISOString().replace("T", " ").slice(0, 19),

    pair: "BTC/USDT",

    type:
      order.orderType === "limit"
        ? "Limit"
        : order.orderType === "market"
        ? "Market"
        : "Trigger",

    side: order.orderSide === "buy" ? "Buy" : "Sell",

    qty: `${order.totalUnits ?? 0}`,

    price: order.entryPrice ?? 0,

    takeProfit: order.takeProfitEnabled
      ? order.multipleTpEnabled && order.multipleTakeProfits?.length
        ? order.multipleTakeProfits.map((tp, idx) => ({
            label: `TP${idx + 1}`,
            value: tp.profitAmount ?? 0,
          }))
        : order.singleTakeProfit
        ? [
            {
              label: "TP",
              value: order.singleTakeProfit.profitAmount ?? 0,
            },
          ]
        : []
      : [],

    slTriggerPrice: order.stopLossEnabled
      ? order.stopLoss?.triggerPrice ?? 0
      : 0,

    slLimit: order.stopLossEnabled ? order.stopLoss?.limitPrice ?? 0 : 0,

    trail: order.stopLoss?.trailVariance ? order.stopLoss.trailVariance : 0,

    loop: order.loopEnabled
      ? order.noOfLoops === null
        ? "∞"
        : String(order.noOfLoops)
      : "-",

    triggerCondition:
      order.orderType === "trigger"
        ? `${order.triggerMode?.toUpperCase()} @ ${order.triggerPrice}`
        : "-",

    total: order.totalAmount ? `$${order.totalAmount}` : "-",
  };
}

// for rounding the number to a particular number of decimal places
export function roundTo(value: number, decimals = 2) {
  return Number(value.toFixed(decimals));
}

export function groupOrdersByTick(
  orders: OrderBookRowType[],
  tick: number
): OrderBookRowType[] {
  const map = new Map<number, OrderBookRowType>();

  for (const o of orders) {
    const price = Math.floor(o.price / tick) * tick;

    const key = roundTo(price, 8);
    const existing = map.get(key);

    if (existing) {
      existing.amount += o.amount;
      existing.total += o.total;
    } else {
      map.set(key, {
        ...o,
        price: key,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    orders[0]?.side === "sell" ? b.price - a.price : a.price - b.price
  );
}

export function calculateRatio(
  buys: OrderBookRowType[],
  sells: OrderBookRowType[]
) {
  const buy = buys.reduce((s, o) => s + o.total, 0);
  const sell = sells.reduce((s, o) => s + o.total, 0);

  const total = buy + sell || 1;

  return {
    buyRatio: Math.round((buy / total) * 100),
    sellRatio: Math.round((sell / total) * 100),
  };
}

# Copilot prompt library

Copy/paste into `/copilot` or Ask page (in-domain). Includes Sanujit-style cases and multi-leg.

---

## Reads

```
what's my health factor
am I safe
how much have I deposited
how much do I owe
USDC pool stats
price of XLM
prices of XLM and USDC
can I borrow 20 USDC
list all earn pools
what is being shown on my screen
what is Blend
how does margin work on Vanna
```

---

## Single-leg writes

```
lend 10 XLM
lend 20 USDC
deposit 5 XLM as collateral
deposit 10 BLUSDC as collateral
borrow 5 BLUSDC
repay 5 BLUSDC
redeem 5 XLM
swap 10 XLM to BLUSDC
swap 10 XLM to AQUSDC via aquarius
farm Blend at 2x with 10 BLUSDC
open a margin account
create my smart account
enable auto-sign
disable auto-sign
```

---

## Multi-leg / strategy (priority)

```
park 20 XLM for yield then farm 10 BLUSDC at 2x keep HF above 1.4
swap 10 XLM to BLUSDC then farm Blend at 2x with 10 BLUSDC
repay 5 BLUSDC then deposit 10 XLM as collateral
deposit 20 XLM and borrow at 2x
park 20 XLM for yield then also deposit 10 BLUSDC as collateral
farm Blend at 3x with 15 BLUSDC keep health above 1.5
lend 50 XLM then swap 10 XLM to BLUSDC then farm at 2x with 10 BLUSDC
```

---

## Sanujit-style edge cases (copilot)

```
supply -5 USDC
lend 0 XLM
lend 999999 XLM
farm Blend at 20x with 10 BLUSDC
deposit 1.4 XLM keep HF above 1.4
borrow without amount
lend DOGE
invest where yield is highest with 20 XLM
use default auto-sign caps
set auto-sign cap to 500 per tx
```

---

## Domain firewall (must be refused)

```
write me a python function to sort a list
write me an essay on climate change
solve this leetcode problem
debug my javascript code
what's a good pasta recipe
```

---

## Notes

- Prefer **auto-approve on** for multi-leg E2E.  
- Use Ask panel **New chat** to clear side-panel history.  
- HF floors are constraints, never amounts.  

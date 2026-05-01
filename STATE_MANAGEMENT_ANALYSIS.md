# State Management Analysis & Recommendations

## 📊 Current State Management Overview

### Existing Stores (Zustand)
1. **`collateral-borrow-store.ts`**
   - Manages: `collaterals[]`, `borrowItems[]`
   - Status: ✅ Good - Global state for core data
   - Issues: `borrowItems` also stored locally in components (duplication)

2. **`margin-account-info-store.ts`**
   - Manages: Account metrics (totalBorrowedValue, totalCollateralValue, healthFactor, etc.)
   - Status: ✅ Good - Read-only metrics store
   - Issues: None significant

### Current State Distribution Issues

#### 🔴 **Problem Areas:**

1. **Props Drilling (Heavy)**
   - `leverage`, `setLeverage` - passed through 3 levels
   - `depositAmount`, `setDepositAmount` - passed through 2 levels
   - `totalDeposit`, `setTotalDeposit` - passed through 2 levels
   - `depositCurrency`, `setDepositCurrency` - passed through 2 levels
   - `hasMarginAccount` - hardcoded, should be in store

2. **Scattered Local State**
   - **`leverage-collateral.tsx`**: 15+ useState hooks
     - Tab state (`activeTab`, `hoveredTab`)
     - Dialogue visibility (`isCreateMarginDialogueOpen`, `isSecondDialogueOpen`)
     - Calculation states (`platformPoints`, `fees`, `totalDeposit`, `updatedCollateral`, `netHealthFactor`)
     - Form states (`depositAmount`, `depositCurrency`, `leverage`)
     - Local data collection (`currentCollaterals`, `currentBorrowItems`)
   
   - **`leverage-assets-tab.tsx`**: 3+ useState hooks
     - UI state (`editingIndex`, `mode`)
     - Local `borrowItems` (duplicates store)
   
   - **`borrow-box.tsx`**: Multiple useState hooks
     - Form state (`selectedOptions`, `inputValues`)
     - Local `borrowItems` state
   
   - **`repay-loan-tab.tsx`**: Multiple useState hooks
     - Form state (`selectedRepayCurrency`, `repayAmount`, `selectedRepayPercentage`)
     - Popup visibility states

3. **State Duplication**
   - `borrowItems` exists in:
     - ✅ Store (`collateral-borrow-store`)
     - ❌ Local state in `leverage-assets-tab.tsx`
     - ❌ Local state in `borrow-box.tsx`
   
   - `collaterals` exists in:
     - ✅ Store (`collateral-borrow-store`)
     - ❌ Local state in `leverage-collateral.tsx` (`currentCollaterals`)

4. **Derived/Computed Values Stored as State**
   - `platformPoints` = `leverage * 0.575` (should be computed)
   - `updatedCollateral` = `depositAmount * leverage * 0.6` (should be computed)
   - `netHealthFactor` = `2.0 - leverage * 0.0875` (should be computed)
   - `fees` = `depositAmount * 0.000234` (should be computed)
   - `totalDeposit` = `depositAmount + fees` (should be computed)

5. **Missing Global State**
   - `hasMarginAccount` - Currently hardcoded, should be in store
   - `activeTab` - Tab state should be global for navigation
   - `mode` (Deposit/Borrow) - Should be in store for persistence
   - `leverage` - Should be in store (currently passed as prop)

---

## 🎯 Recommended Centralized State Management

### Proposed Store Structure

#### **Option 1: Single Unified Margin Store (Recommended)**

```typescript
// store/margin-store.ts

interface MarginStoreState {
  // ========== Account State ==========
  account: {
    hasMarginAccount: boolean;
    isAccountCreated: boolean;
    accountAddress?: string;
  };

  // ========== UI State ==========
  ui: {
    activeTab: "Leverage your Assets" | "Repay Loan";
    hoveredTab: "Leverage your Assets" | "Repay Loan" | null;
    mode: "Deposit" | "Borrow";
    editingIndex: number | null;
    isCreateMarginDialogueOpen: boolean;
    isSecondDialogueOpen: boolean;
    isPayNowPopupOpen: boolean;
    isFlashClosePopupOpen: boolean;
  };

  // ========== Form State ==========
  form: {
    leverage: number;
    depositAmount: number;
    depositCurrency: string;
    selectedRepayCurrency: string;
    selectedRepayPercentage: number;
    repayAmount: number;
  };

  // ========== Data State (from existing stores) ==========
  data: {
    collaterals: Collaterals[];
    borrowItems: BorrowInfo[];
  };

  // ========== Repay Stats ==========
  repayStats: {
    netOutstandingAmountToPay: number;
    availableBalance: number;
    frozenBalance: number;
  };

  // ========== Computed/Derived Values (Getters) ==========
  // These would be computed, not stored
  computed: {
    platformPoints: number;        // leverage * 0.575
    updatedCollateral: number;     // depositAmount * leverage * 0.6
    netHealthFactor: number;       // 2.0 - leverage * 0.0875
    fees: number;                  // depositAmount * 0.000234
    totalDeposit: number;          // depositAmount + fees
    totalDepositValue: number;     // sum of collaterals.amountInUsd
  };
}
```

#### **Option 2: Separate Stores by Domain (Alternative)**

```typescript
// store/margin-ui-store.ts - UI state only
// store/margin-form-store.ts - Form inputs
// store/margin-data-store.ts - Business data (merge existing two)
// store/margin-computed-store.ts - Derived values
```

---

## ✅ Benefits of Centralized State

### 1. **Eliminate Props Drilling**
   - No more passing `leverage`, `depositAmount`, etc. through multiple components
   - Direct access via `useMarginStore((state) => state.form.leverage)`

### 2. **Single Source of Truth**
   - No duplicate state (borrowItems, collaterals)
   - Consistent data across all components

### 3. **Better State Persistence**
   - Tab state persists across navigation
   - Form state persists on page refresh
   - User preferences saved

### 4. **Computed Values as Selectors**
   - Use Zustand selectors for derived values
   - Automatic recalculation when dependencies change
   - No manual `useEffect` for calculations

### 5. **Easier Testing & Debugging**
   - All state in one place
   - Better DevTools visibility
   - Easier to track state changes

### 6. **Better Performance**
   - Granular selectors prevent unnecessary re-renders
   - Computed values only recalculate when needed

---

## 📋 Migration Plan

### Phase 1: Create Unified Store
1. Create `store/margin-store.ts` with unified structure
2. Keep existing stores temporarily for backward compatibility
3. Gradually migrate components

### Phase 2: Migrate UI State
1. Move tab state (`activeTab`, `hoveredTab`)
2. Move dialogue/popup visibility states
3. Move `editingIndex`, `mode`

### Phase 3: Migrate Form State
1. Move `leverage`, `depositAmount`, `depositCurrency`
2. Move repay form state
3. Remove props drilling

### Phase 4: Consolidate Data Stores
1. Merge `collateral-borrow-store` into unified store
2. Keep `margin-account-info-store` separate (read-only metrics)
3. Remove duplicate local state

### Phase 5: Add Computed Selectors
1. Replace stored calculated values with selectors
2. Remove calculation `useEffect` hooks
3. Use Zustand selectors for derived values

### Phase 6: Cleanup
1. Remove old stores (if fully migrated)
2. Remove unused props
3. Update all component imports

---

## 🔧 Implementation Example

### Before (Current):
```typescript
// leverage-collateral.tsx
const [leverage, setLeverage] = useState(2);
const [depositAmount, setDepositAmount] = useState(0);
const [activeTab, setActiveTab] = useState<Tabs>("Leverage your Assets");

// Pass as props
<LeverageAssetsTab
  leverage={leverage}
  setLeverage={setLeverage}
  depositAmount={depositAmount}
  setDepositAmount={setDepositAmount}
/>
```

### After (Centralized):
```typescript
// leverage-collateral.tsx
const leverage = useMarginStore((state) => state.form.leverage);
const setLeverage = useMarginStore((state) => state.setLeverage);
const activeTab = useMarginStore((state) => state.ui.activeTab);
const setActiveTab = useMarginStore((state) => state.setActiveTab);

// No props needed
<LeverageAssetsTab />
```

### Computed Values Example:
```typescript
// In store definition
const useMarginStore = createNewStore(initialState, {...});

// Computed selector
export const usePlatformPoints = () => 
  useMarginStore((state) => state.form.leverage * 0.575);

export const useTotalDeposit = () => 
  useMarginStore((state) => {
    const fees = state.form.depositAmount * 0.000234;
    return state.form.depositAmount + fees;
  });
```

---

## 🎨 Store Structure Recommendation

### Recommended: **Option 1 - Single Unified Store**

**Why?**
- ✅ Simpler mental model
- ✅ All margin-related state in one place
- ✅ Easier to maintain
- ✅ Better for small-to-medium apps
- ✅ Zustand handles performance well with selectors

**Structure:**
```
store/
  ├── margin-store.ts          (NEW - Unified store)
  ├── margin-account-info-store.ts  (KEEP - Read-only metrics)
  └── [Remove] collateral-borrow-store.ts  (Migrate to margin-store)
```

---

## 📊 State Categories

### 1. **Global Business State** → Store
   - Collaterals, BorrowItems
   - Account status
   - Repay stats

### 2. **UI State** → Store (if needs persistence)
   - Active tab
   - Mode (Deposit/Borrow)
   - Editing state
   - Dialogue visibility

### 3. **Form State** → Store (if needs persistence)
   - Leverage, Deposit amount
   - Selected currencies
   - Input values

### 4. **Computed Values** → Selectors (NOT stored)
   - Platform points
   - Fees
   - Total deposit
   - Health factor

### 5. **Temporary UI State** → Local useState (OK)
   - Hover states
   - Animation states
   - Temporary form validation

---

## ⚠️ Things to Keep Local

These should **NOT** go to store:
- Animation states (`whileHover`, `whileTap`)
- Temporary UI feedback
- Component-specific refs
- One-time calculations
- Event handlers

---

## 🚀 Next Steps

1. **Review this analysis** - Confirm approach
2. **Create `store/margin-store.ts`** - Implement unified store
3. **Start migration** - Begin with one component
4. **Test thoroughly** - Ensure no regressions
5. **Gradually migrate** - Move one feature at a time

---

## 📝 Notes

- Keep `margin-account-info-store.ts` separate (it's read-only metrics)
- Consider keeping positions data in a separate store (if it grows)
- Use TypeScript strictly for type safety
- Add JSDoc comments for complex selectors
- Consider adding middleware for logging/analytics

---

**Created:** $(date)
**Status:** Analysis Complete - Ready for Implementation Review


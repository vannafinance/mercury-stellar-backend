import { UseFormSetValue } from "react-hook-form";
import { OrderPlacementFormValues } from "@/lib/types";

export const resetOrderForm = (
  setValue: UseFormSetValue<OrderPlacementFormValues>,
  removeMultiTp: () => void
) => {
  //Entry / Qty / Amount
  setValue("entryPrice", null);
  setValue("totalUnits", null);
  setValue("totalAmount", null);

  //Trigger
  setValue("triggerPrice", null);

  //Take Profit
  setValue("takeProfitEnabled", false);
  setValue("multipleTpEnabled", false);
  setValue("singleTakeProfit", {
    exitPrice: null,
    profitPercent: null,
    profitAmount: null,
  });

  removeMultiTp(); // clear multi TP rows

  //Stop Loss
  setValue("stopLossEnabled", false);
  setValue("stopLoss", {
    triggerPrice: null,
    limitPrice: null,
    trailVariance: null,
    trailVarianceUnit: "USD",
    rrRatio: "NA",
    customRR: null,
  });
};

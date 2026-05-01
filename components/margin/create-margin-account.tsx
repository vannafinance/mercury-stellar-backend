"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useMarginAccountInfoStore, createMarginAccount, checkUserMarginAccount, resetCreationState } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { MarginAccountService } from "@/lib/margin-utils";
import { useTheme } from "@/contexts/theme-context";

interface CreateMarginAccountProps {
  onAccountCreated?: () => void;
}

export const CreateMarginAccount = ({ onAccountCreated }: CreateMarginAccountProps) => {
  const { isDark } = useTheme();
  const userAddress = useUserStore((state) => state.address);
  
  // Store actions and state
  const hasMarginAccount = useMarginAccountInfoStore((state) => state.hasMarginAccount);
  const marginAccountAddress = useMarginAccountInfoStore((state) => state.marginAccountAddress);
  const isCreatingAccount = useMarginAccountInfoStore((state) => state.isCreatingAccount);
  const accountCreationError = useMarginAccountInfoStore((state) => state.accountCreationError);

  const [showAgreement, setShowAgreement] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [isCheckingAccount, setIsCheckingAccount] = useState(false);

  // Check for existing margin account on mount and when user changes
  useEffect(() => {
    if (userAddress) {
      // Reset any previous creation state when switching users
      resetCreationState();
      // Check for existing margin account (now async)
      setIsCheckingAccount(true);
      checkUserMarginAccount(userAddress)
        .catch(console.error)
        .finally(() => setIsCheckingAccount(false));
    } else {
      // If no user address (wallet disconnected), reset creation state
      resetCreationState();
      setIsCheckingAccount(false);
    }
  }, [userAddress]);

  // Cleanup effect - reset creation state when component unmounts
  useEffect(() => {
    return () => {
      // Reset creation state when component unmounts
      resetCreationState();
    };
  }, []);

  // Handle margin account creation
  const handleCreateAccount = async () => {
    if (!userAddress) {
      console.error("No user address available for margin account creation");
      return;
    }
    
    try {
      const success = await createMarginAccount(userAddress);
      if (success) {
        setShowAgreement(false);
        setAgreedToTerms(false);
        if (onAccountCreated) {
          onAccountCreated();
        }
      }
    } catch (error) {
      console.error("Failed to create margin account:", error);
    }
  };

  // Show agreement modal
  const handleSignAgreement = () => {
    if (!agreedToTerms) return;
    setShowAgreement(false);
    handleCreateAccount();
  };

  if (!userAddress) {
    return (
      <motion.div
        className={`w-full p-6 rounded-xl border ${
          isDark ? "bg-gray-800 border-gray-700" : "bg-gray-50 border-gray-200"
        }`}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="flex items-center justify-center py-8">
          <p className={`text-lg ${isDark ? "text-gray-300" : "text-gray-600"}`}>
            Please connect your wallet to continue
          </p>
        </div>
      </motion.div>
    );
  }

  // Show loading state while checking for existing account
  if (isCheckingAccount) {
    return (
      <motion.div
        className={`w-full p-6 rounded-xl border ${
          isDark ? "bg-gray-800 border-gray-700" : "bg-white border-gray-200"
        }`}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="flex flex-col items-center justify-center py-8 gap-4">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <p className={`text-lg ${isDark ? "text-gray-300" : "text-gray-600"}`}>
            Checking for existing margin account...
          </p>
        </div>
      </motion.div>
    );
  }

  // If user already has a margin account
  if (hasMarginAccount && marginAccountAddress) {
    return (
      <motion.div
        className={`w-full p-6 rounded-xl border ${
          isDark ? "bg-green-900/20 border-green-700" : "bg-green-50 border-green-200"
        }`}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="flex items-center gap-4">
          <div className={`p-2 rounded-full ${
            isDark ? "bg-green-700" : "bg-green-100"
          }`}>
            <svg className={`w-6 h-6 ${
              isDark ? "text-green-300" : "text-green-600"
            }`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className={`text-lg font-semibold ${
              isDark ? "text-green-300" : "text-green-800"
            }`}>
              Margin Account Active
            </h3>
            <p className={`text-sm ${
              isDark ? "text-green-200" : "text-green-700"
            }`}>
              Account: {MarginAccountService.formatAccountAddress(marginAccountAddress)}
            </p>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <>
      <motion.div
        className={`w-full p-6 rounded-xl border ${
          isDark ? "bg-gray-800 border-gray-700" : "bg-white border-gray-200"
        }`}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="text-center space-y-4">
          <h3 className={`text-xl font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
            Create Your Margin Account
          </h3>
          
          <p className={`text-sm ${isDark ? "text-gray-300" : "text-gray-600"}`}>
            You need a margin account to start borrowing and leveraging your assets on Vanna Protocol.
          </p>

          {accountCreationError && (
            <motion.div
              className={`p-4 rounded-lg border ${
                isDark ? "bg-red-900/20 border-red-700" : "bg-red-50 border-red-200"
              }`}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
            >
              <div className="flex items-center gap-3">
                <svg className={`w-5 h-5 ${
                  isDark ? "text-red-400" : "text-red-600"
                }`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.068 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <p className={`text-sm ${
                  isDark ? "text-red-300" : "text-red-700"
                }`}>
                  {accountCreationError}
                </p>
              </div>
            </motion.div>
          )}

          <motion.button
            className={`w-full py-3 px-6 rounded-lg font-medium transition-all duration-200 ${
              isCreatingAccount
                ? `${isDark ? "bg-gray-700 text-gray-400" : "bg-gray-300 text-gray-500"} cursor-not-allowed`
                : `${isDark ? "bg-blue-600 hover:bg-blue-700 text-white" : "bg-blue-600 hover:bg-blue-700 text-white"} hover:scale-[1.02]`
            }`}
            onClick={() => setShowAgreement(true)}
            disabled={isCreatingAccount}
            whileHover={{ scale: isCreatingAccount ? 1 : 1.02 }}
            whileTap={{ scale: isCreatingAccount ? 1 : 0.98 }}
          >
            {isCreatingAccount ? (
              <div className="flex items-center justify-center gap-2">
                <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                Creating Account...
              </div>
            ) : (
              "Create your Margin Account"
            )}
          </motion.button>
        </div>
      </motion.div>

      {/* Agreement Modal */}
      <AnimatePresence>
        {showAgreement && (
          <motion.div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={(e) => e.target === e.currentTarget && setShowAgreement(false)}
          >
            <motion.div
              className={`max-w-md w-full rounded-xl p-6 max-h-[90vh] overflow-y-auto ${
                isDark ? "bg-gray-800" : "bg-white"
              }`}
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
            >
              <div className="space-y-6">
                <div className="text-center">
                  <h3 className={`text-xl font-bold ${isDark ? "text-white" : "text-gray-900"}`}>
                    Review and Sign Agreement
                  </h3>
                  <p className={`text-sm mt-2 ${isDark ? "text-gray-300" : "text-gray-600"}`}>
                    Before you proceed, please review and accept the terms of borrowing on VANNA.
                  </p>
                </div>

                <div className={`space-y-4 text-sm ${isDark ? "text-gray-300" : "text-gray-600"}`}>
                  <div>
                    <h4 className={`font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
                      1. Collateral Requirement
                    </h4>
                    <ul className="list-disc list-inside ml-2 space-y-1">
                      <li>All borrowed positions must remain fully collateralized.</li>
                      <li>If collateral value falls below the liquidation threshold, your position may be liquidated.</li>
                    </ul>
                  </div>

                  <div>
                    <h4 className={`font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
                      2. Borrow Limits & Leverage
                    </h4>
                    <ul className="list-disc list-inside ml-2 space-y-1">
                      <li>You may only borrow assets up to the maximum Loan-to-Value (LTV) allowed.</li>
                      <li>Leverage is enabled only when collateral value supports it.</li>
                    </ul>
                  </div>

                  <div>
                    <h4 className={`font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
                      3. Interest & Fees
                    </h4>
                    <ul className="list-disc list-inside ml-2 space-y-1">
                      <li>Interest rates are variable and accrue in real time.</li>
                      <li>Additional protocol fees may apply for borrowing or liquidation events.</li>
                    </ul>
                  </div>

                  <div>
                    <h4 className={`font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
                      4. Liquidation Risk
                    </h4>
                    <ul className="list-disc list-inside ml-2 space-y-1">
                      <li>Market volatility can reduce collateral value.</li>
                      <li>If your position health factor drops below safe limits, collateral may be partially or fully liquidated without prior notice.</li>
                    </ul>
                  </div>

                  <div>
                    <h4 className={`font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
                      5. User Responsibility
                    </h4>
                    <ul className="list-disc list-inside ml-2 space-y-1">
                      <li>You are responsible for monitoring your positions, balances, and risks.</li>
                      <li>VANNA operates under a decentralized protocol with inherent smart contract risks.</li>
                    </ul>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="agree-terms"
                    checked={agreedToTerms}
                    onChange={(e) => setAgreedToTerms(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <label
                    htmlFor="agree-terms"
                    className={`text-sm ${isDark ? "text-gray-300" : "text-gray-600"}`}
                  >
                    I have read and agree to the VANNA Borrow Agreement.
                  </label>
                </div>

                <div className="flex gap-3">
                  <button
                    className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
                      isDark
                        ? "bg-gray-700 hover:bg-gray-600 text-gray-300"
                        : "bg-gray-200 hover:bg-gray-300 text-gray-700"
                    }`}
                    onClick={() => setShowAgreement(false)}
                  >
                    Close
                  </button>
                  
                  <button
                    className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
                      agreedToTerms
                        ? "bg-blue-600 hover:bg-blue-700 text-white"
                        : `${isDark ? "bg-gray-600" : "bg-gray-300"} text-gray-400 cursor-not-allowed`
                    }`}
                    onClick={handleSignAgreement}
                    disabled={!agreedToTerms}
                  >
                    Sign Agreement
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
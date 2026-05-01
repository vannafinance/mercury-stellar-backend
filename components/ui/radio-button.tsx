"use client";

import React, { useRef, forwardRef } from "react";

// ============================================
// Radio Component For indiviusal component 
// ============================================


export interface RadioProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: boolean;
  className?: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  ({ label, error = false, className = "", ...rest }, ref) => {
    const internalRef = useRef<HTMLInputElement>(null);
    const inputRef = (ref as React.RefObject<HTMLInputElement>) || internalRef;

    const handleFocusForward = () => {
      if (inputRef && "current" in inputRef) {
        inputRef.current?.focus();
      }
    };

    const isDisabled = rest.disabled;

    return (
      <label
        className={`flex items-center gap-3 select-none ${
          isDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
        }`}
        onClick={handleFocusForward}

      >



          {/* 
          /* //////////////////////////////
             Invisible but interactive input
           /////////////////////////////////
            */}



        <input
          ref={inputRef}
          type="radio"
          {...rest}
          className="peer absolute opacity-0 h-5 w-5"
        />

        {/* //////////////////////
            Visual radio button
           ////////////////////// */
        }



        <span
          className={`
            relative w-5 h-5 rounded-full flex items-center justify-center border-2 transition-all
            [&>span]:opacity-0 
            peer-checked:[&>span]:opacity-100
            ${error ? "border-[#FC5457]" : "border-gray-300"}
            peer-hover:border-[#703AE6]
            peer-focus:border-[#F845FC]
            peer-focus:ring-4 peer-focus:ring-[#F845FC]/30
            peer-checked:border-[#703AE6]
            peer-checked:ring-4 peer-checked:ring-[#703AE6]/40
            ${className}
          `}
        >
          {/* Inner dot */}
          <span className="w-2 h-2 rounded-full bg-[#703AE6] transition-opacity" />
        </span>

        {label && (
          <span className={`${error ? "text-[#FC5457]" : ""}`}>{label}</span>
        )}
      </label>
    );
  }
);



Radio.displayName = "Radio";





// ========================================================================
// RadioGroup Component :- No need to write Logic for indivisual radio button 
// ============================================================================




export interface RadioGroupProps {
  name: string;
  value?: string;
  onChange?: (value: string) => void;
  children: React.ReactNode;
  error?: boolean;
  className?: string;
}



export const RadioGroup = ({
  name,
  value,
  onChange,
  children,
  error = false,
  className = "",
}: RadioGroupProps) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (onChange) {
      onChange(e.target.value);
    }
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {React.Children.map(children, (child) => {
        if (React.isValidElement<RadioProps>(child)) {
          return React.cloneElement(child, {
            name,
            checked: child.props.value === value,
            onChange: handleChange,
            error: error || child.props.error,
          });
        }
        return child;
      })}
    </div>
  );
};
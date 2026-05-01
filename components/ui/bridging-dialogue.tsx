import { useEffect, useState } from "react";
import { Button } from "./button";
import { motion, AnimatePresence } from "framer-motion";

interface BridgingDialogueProps {
  heading: string;
  content: {
    title: string;
    isDone: boolean;
  }[];
  onClose: () => void;

  buttonText: string;
  buttonOnClick: () => void;
  timer: number;
}

export const BridgingDialogue = (props: BridgingDialogueProps) => {
  const [timer, setTimer] = useState(props.timer);
  const [isTimerRunning, setIsTimerRunning] = useState(true);

  useEffect(() => {
    if (!isTimerRunning) return;

    const interval = setInterval(() => {
      setTimer((prevTimer) => {
        const newTimer = prevTimer - 0.01;
        if (newTimer <= 0) {
          setIsTimerRunning(false);
          return 0;
        }
        return newTimer;
      });
    }, 10);
    return () => clearInterval(interval);
  }, [isTimerRunning]);

  useEffect(() => {
    // Check if timer is 0 and all items are done
    const allDone = props.content.every((item) => item.isDone);
    if (timer <= 0 && allDone) {
      props.onClose();
    }
  }, [timer, props.content, props.onClose]);

  return (
    <motion.div
      className="p-[24px] flex flex-col gap-[16px] items-center rounded-[24px] bg-white w-[360px]"
      initial={{ opacity: 0, scale: 0.9, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: 20 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
    >
      <motion.div
        className="text-[28px] font-bold text-center"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        {props.heading}
      </motion.div>
      <motion.div
        className="text-white text-[16px] font-semibold flex flex-col justify-center items-center py-[10px] px-[20px] w-[80px] h-[80px] rounded-full bg-gradient"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{
          opacity: 1,
          scale: isTimerRunning ? [1, 1.05, 1] : 1,
        }}
        transition={{
          duration: 0.4,
          delay: 0.2,
          scale: {
            duration: 2,
            repeat: isTimerRunning ? Infinity : 0,
            ease: "easeInOut",
          },
        }}
      >
        {Math.max(0, timer).toFixed(2)}
      </motion.div>
      <div className="w-full flex flex-col gap-[18px]">
        {props.content.map((item, idx) => {
          return (
            <motion.div
              className="w-full flex justify-between items-center"
              key={idx}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: 0.3 + idx * 0.1 }}
            >
              <motion.div
                className="text-[16px] font-medium text-[#131313A1]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3, delay: 0.3 + idx * 0.1 + 0.1 }}
              >
                {item.title}
              </motion.div>
              <AnimatePresence mode="wait">
                {item.isDone ? (
                  <motion.div
                    key="checkmark"
                    className="text-white rounded-full p-[4px] bg-[#703AE6]"
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0 }}
                    transition={{
                      duration: 0.3,
                      type: "spring",
                      stiffness: 200,
                    }}
                  >
                    <motion.svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.5, delay: 0.1 }}
                    >
                      <path
                        d="M13.3327 4L5.99935 11.3333L2.66602 8"
                        stroke="white"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </motion.svg>
                  </motion.div>
                ) : (
                  <motion.div
                    key="spinner"
                    className="text-white rounded-full p-[4px] bg-[#703AE6]"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.3 }}
                  >
                    <motion.svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      animate={{ rotate: 360 }}
                      transition={{
                        duration: 1,
                        repeat: Infinity,
                        ease: "linear",
                      }}
                    >
                      <circle
                        cx="8"
                        cy="8"
                        r="6"
                        stroke="white"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeDasharray="28 12"
                        fill="none"
                        opacity="0.8"
                      />
                    </motion.svg>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>
      <motion.div
        className="py-[12px] px-[8px] rounded-[18px] underline text-[12px] font-semibold items-center text-center cursor-pointer"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.3 + props.content.length * 0.1 }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={props.buttonOnClick}
      >
        {props.buttonText}
      </motion.div>
    </motion.div>
  );
};

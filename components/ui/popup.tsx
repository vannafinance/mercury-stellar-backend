import Image from "next/image"
import { Button } from "./button"
import { useTheme } from "@/contexts/theme-context"

interface Popup {
    icon:string,
    description:string
    buttonText?:string
    buttonOnClick:()=>void
    closeButtonText?:string
    closeButtonOnClick?:()=>void
    iconBgColor?:string
}

export const Popup = (props:Popup)=>{
    const { isDark } = useTheme();
    
    return <div className={`w-[353px] shadow-md w-[336px] rounded-[16px] py-[20px] px-[16px] flex flex-col justify-center items-center gap-[16px] ${
        isDark ? "bg-[#111111]" : "bg-white"
    }`}>
       <div className={`rounded-[26px] p-[12px] ${props.iconBgColor || (isDark ? "bg-[#222222]" : "bg-[#FFEEEE]")}`}>
        <Image src={props.icon} alt={props.icon} width={20} height={21.81} />
        </div> 
        <div className={`text-center text-[14px] font-medium ${
            isDark ? "text-white" : ""
        }`}>
            {props.description}
        </div>
        <div className="w-full flex gap-[16px]">
          
            <Button disabled={false} size="small" type="ghost" text={props.closeButtonText?props.closeButtonText:"Close"} onClick={props.closeButtonOnClick}/>
            {props.buttonText &&  <Button disabled={false} size="small" type="solid" text={props.buttonText} onClick={props.buttonOnClick}/>}
        </div>
    </div>
}
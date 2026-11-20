import type { ButtonHTMLAttributes } from "react";

/** Keep the hit target/material fixed; navigation motion owns only the inner content. */
export function IOSHeaderButton({ children, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} {...props}><span className="hg-ios-action-content">{children}</span></button>;
}

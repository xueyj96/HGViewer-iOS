import type { ComponentPropsWithRef } from "react";
import { ICheck } from "../icons";

type ChoiceListProps = ComponentPropsWithRef<"div">;

export function ChoiceList({ className, ...props }: ChoiceListProps) {
  return <div {...props} className={`hg-ios-choice-list${className ? ` ${className}` : ""}`} />;
}

export function ChoiceRow({ label, hint, selected, disabled, destructive, role, onClick, className, tabIndex }:
  { label: string; hint?: string; selected?: boolean; disabled?: boolean; destructive?: boolean; role?: "menuitem";
    onClick: () => void; className?: string; tabIndex?: number }) {
  return (
    <button type="button" role={role} tabIndex={tabIndex} onClick={onClick} disabled={disabled}
      aria-label={label} aria-description={hint} aria-pressed={selected === undefined ? undefined : selected}
      title={hint} data-has-hint={hint ? "true" : undefined} data-destructive={destructive ? "true" : undefined}
      className={`hg-ios-choice-row${className ? ` ${className}` : ""}`}>
      <span className="hg-ios-choice-copy">
        <span className="hg-ios-choice-label">{label}</span>
        {hint && <span className="hg-ios-choice-hint">{hint}</span>}
      </span>
      {selected !== undefined && <span className="hg-ios-choice-mark" aria-hidden="true">
        {selected && <ICheck size={16} />}
      </span>}
    </button>
  );
}

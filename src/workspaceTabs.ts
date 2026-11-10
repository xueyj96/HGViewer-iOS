import { IGrid, IGridF, IHome, IHomeF, IList, ISearch } from "./icons";

export const WORKSPACE_SEARCH_TAB = { k: "search", label: "搜索", Icon: ISearch, SelectedIcon: ISearch } as const;

// The order also defines the 1–4 keyboard shortcuts.
export const WORKSPACE_TABS = [
  { k: "home", label: "首页", Icon: IHome, SelectedIcon: IHomeF },
  WORKSPACE_SEARCH_TAB,
  { k: "category", label: "分类", Icon: IGrid, SelectedIcon: IGridF },
  { k: "profile", label: "资料库", Icon: IList, SelectedIcon: IList },
] as const;

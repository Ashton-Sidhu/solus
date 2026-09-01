import { getContext, setContext } from "svelte";

type SidebarStateProps = {
  open: () => boolean;
  setOpen: (open: boolean) => void;
};

class SidebarState {
  open = $derived.by(() => this.props.open());
  state = $derived(this.open ? "expanded" : "collapsed");

  constructor(private props: SidebarStateProps) {}

  setOpen(open: boolean) {
    this.props.setOpen(open);
  }

  toggle() {
    this.setOpen(!this.open);
  }
}

const SIDEBAR_CONTEXT = Symbol("solus-sidebar");

export function setSidebar(props: SidebarStateProps): SidebarState {
  return setContext(SIDEBAR_CONTEXT, new SidebarState(props));
}

export function useSidebar(): SidebarState {
  return getContext<SidebarState>(SIDEBAR_CONTEXT);
}

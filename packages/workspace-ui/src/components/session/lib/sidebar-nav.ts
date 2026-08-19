/**
 * The sidebar destinations that are routed pages. Each one can be shown over
 * the conversation or beside it, which is what the nav's context menu offers.
 *
 * History is deliberately absent: it summons the session picker overlay rather
 * than navigating, so there is no route to put in a pane.
 */
export type SidebarNavPage = 'folio' | 'automations' | 'insights' | 'prs' | 'tasks'

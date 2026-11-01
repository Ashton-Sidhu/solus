/** How many runs a run graph looks back over — wide enough to show a rhythm,
 *  narrow enough that one bad run still reads as one bad run. Its own module so
 *  that the store, which loads with the workspace, does not bring the run
 *  formatting and its cron parser. */
export const RUN_GRAPH_WINDOW = 17

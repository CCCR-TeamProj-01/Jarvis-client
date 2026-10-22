/**
 * The server address put into the app when it was built: `MAIN_VITE_JARVIS_SERVER_URL`, which the
 * build replaces with its value right here (so the name must stay written out in full). It is not
 * read while the app runs, and nothing at run time can change it. Empty when none was given.
 */
export const BUNDLED_SERVER_URL: string | undefined = import.meta.env.MAIN_VITE_JARVIS_SERVER_URL

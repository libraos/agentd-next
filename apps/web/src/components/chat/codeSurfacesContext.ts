import { createContext } from "react";

/** False in a chat, which has no browser, terminal or diff panels to open things in. */
export const CodeSurfacesContext = createContext(true);

// Shim for react/jsx-dev-runtime
// Workers SSR runner doesn't properly load the CJS development build.
// React 19's jsxDEV is compatible with jsx, so we just re-export jsx as jsxDEV.
import { jsx, jsxs, Fragment } from "react/jsx-runtime";

// jsxDEV in React 19 has the same signature as jsx (the extra params are ignored)
export { Fragment };
export const jsxDEV = jsx;
export const jsxDEVImpl = jsx;

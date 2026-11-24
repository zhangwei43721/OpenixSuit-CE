import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./i18n";
import App from "./App";
import { LogColorProvider } from "./store/logColors";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LogColorProvider>
      <App />
    </LogColorProvider>
  </React.StrictMode>
);

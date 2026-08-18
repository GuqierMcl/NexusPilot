import { createContext, useContext } from "react";

import type { DataTableContextValue } from "./types";

// ─── DataTableContext ──────────────────────────────────────────────────────────

const DataTableContext = createContext<DataTableContextValue | null>(null);
DataTableContext.displayName = "DataTableContext";

// ─── useDataTable ──────────────────────────────────────────────────────────────

export function useDataTable(): DataTableContextValue {
  const ctx = useContext(DataTableContext);
  if (!ctx) {
    throw new Error("useDataTable must be used within <DataTable.Root>");
  }
  return ctx;
}

export { DataTableContext };

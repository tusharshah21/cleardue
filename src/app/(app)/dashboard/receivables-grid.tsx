"use client";

import Link from "next/link";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { StatusBadge, invoiceStatusLabel } from "@/components/status-badge";

ModuleRegistry.registerModules([AllCommunityModule]);

export interface ReceivableRow {
  id: string;
  client: string;
  invoice: string;
  /** A part of a payment plan, shown under its original invoice. */
  isPart: boolean;
  status: string;
  dueDate: string;
  daysOverdue: number;
  outstanding: number;
  outstandingText: string;
  reason: string;
  nextAction: string;
}

const theme = themeQuartz.withParams({ fontFamily: "inherit", headerFontWeight: 600 });

const columns: ColDef<ReceivableRow>[] = [
  {
    field: "client",
    flex: 1.2,
    minWidth: 150,
    cellRenderer: (p: ICellRendererParams<ReceivableRow>) =>
      p.data && (
        <Link href={`/invoices/${p.data.id}`} className="font-medium hover:underline">
          {p.data.isPart && <span aria-hidden className="mr-1 text-muted-foreground">↳</span>}
          {p.value}
        </Link>
      ),
  },
  { field: "invoice", headerName: "Invoice", width: 120 },
  { field: "status", width: 190, valueFormatter: (p) => invoiceStatusLabel(String(p.value ?? ""), p.data?.daysOverdue), cellRenderer: (p: ICellRendererParams<ReceivableRow>) => <StatusBadge status={String(p.value ?? "")} overdueDays={p.data?.daysOverdue} /> },
  { field: "outstanding", headerName: "Outstanding", width: 140, type: "numericColumn", valueFormatter: (p) => p.data?.outstandingText ?? "", filter: false },
  { field: "reason", headerName: "Reason", width: 160, valueFormatter: (p) => p.value || "Not diagnosed yet" },
  { field: "nextAction", headerName: "Next action", flex: 1.5, minWidth: 200, tooltipField: "nextAction" },
  { field: "dueDate", headerName: "Due", width: 120 },
];

export function ReceivablesGrid({ rows }: { rows: ReceivableRow[] }) {
  return (
    <div className={rows.length > 20 ? "h-[640px] w-full" : "w-full"}>
      <AgGridReact<ReceivableRow>
        theme={theme}
        domLayout={rows.length > 20 ? "normal" : "autoHeight"}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        getRowId={(p) => p.data.id}
        pagination={rows.length > 20}
        paginationPageSize={20}
      />
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3 } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format } from "date-fns";

const API_BASE = `${import.meta.env.BASE_URL}api`;

type RunSummary = {
  runFilename: string;
  runId: string;
  generatedAt: string | null;
  strategyName: string | null;
  trades: number | null;
  totalPnlUsd: number | null;
  winRate: number | null;
  maxDrawdownPct: number | null;
};

type RunsResponse = { runs: RunSummary[] };

type EquityPoint = { tsMs: number; equity: number };

type SimulatedTrade = {
  ticker: string;
  side: string;
  entryPrice: number;
  stakeUsd: number;
  contracts: number;
  pnlUsd: number;
  won: boolean;
  usedSyntheticOutcome: boolean;
  reason: string;
  tsMs: number;
};

type BacktestMetrics = {
  strategyName: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnlUsd: number;
  maxDrawdownPct: number;
  sharpeApprox: number;
  equityCurve: EquityPoint[];
  usedSyntheticOutcomes: number;
};

type FullRun = {
  runId?: string;
  runFilename?: string;
  generatedAt: string;
  source?: Record<string, unknown>;
  metrics: BacktestMetrics;
  trades?: SimulatedTrade[];
  tradesPreview?: SimulatedTrade[];
};

type MultiRankRow = {
  rank: number;
  strategyName: string;
  totalPnlUsd: number;
  winRate: number;
  sharpeApprox: number;
  maxDrawdownPct: number;
  trades: number;
  tradesPerHour: number;
  expectancyPerTradeUsd?: number;
};

type MultiReport = {
  generatedAt: string;
  source?: Record<string, unknown>;
  rankings: MultiRankRow[];
  suggestedSettingsPatch?: { rationale?: string };
  outputFiles?: { rankedJson?: string; summaryCsv?: string; tradesCsv?: string };
};

export default function Backtests() {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: multiData, isLoading: multiLoading, error: multiError } = useQuery({
    queryKey: ["/api/pmxt-backtests/multi/latest"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/pmxt-backtests/multi/latest`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || res.statusText);
      }
      return res.json() as Promise<MultiReport>;
    },
    retry: false,
  });

  const {
    data: listData,
    isLoading: listLoading,
    error: listError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ["/api/pmxt-backtests/runs"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/pmxt-backtests/runs`);
      if (!res.ok) throw new Error(res.statusText);
      return res.json() as Promise<RunsResponse>;
    },
  });

  useEffect(() => {
    const runs = listData?.runs ?? [];
    if (runs.length === 0) return;
    setSelectedFile((prev) => {
      if (prev && runs.some((r) => r.runFilename === prev)) return prev;
      return runs[0]!.runFilename;
    });
  }, [listData]);

  const {
    data: detail,
    isLoading: detailLoading,
    error: detailError,
  } = useQuery({
    queryKey: ["/api/pmxt-backtests/runs", selectedFile],
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/pmxt-backtests/runs/${encodeURIComponent(selectedFile!)}`,
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || res.statusText);
      }
      return res.json() as Promise<FullRun>;
    },
    enabled: Boolean(selectedFile),
    retry: false,
  });

  const equityData = useMemo(() => {
    const curve = detail?.metrics?.equityCurve ?? [];
    return curve.map((p) => ({
      t: p.tsMs,
      label: format(new Date(p.tsMs), "HH:mm:ss"),
      equity: Math.round(p.equity * 100) / 100,
    }));
  }, [detail]);

  const tradeRows = detail?.trades?.length ? detail.trades : detail?.tradesPreview ?? [];

  return (
    <Layout>
      <div className="max-w-6xl mx-auto space-y-8 pb-12">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-3xl font-bold font-display text-white tracking-tight flex items-center gap-2">
              <BarChart3 className="w-8 h-8 text-primary" />
              Backtests
            </h2>
            <p className="text-muted-foreground mt-1">
              Pmxt single-strategy runs live under{" "}
              <code className="text-xs bg-black/40 px-1 rounded">data/backtest-results/runs/</code>. Historical
              multi-strategy (Jon-Becker) results load from{" "}
              <code className="text-xs bg-black/40 px-1 rounded">data/backtest-results/multi/last-ranked.json</code> in
              the next card.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ["/api/pmxt-backtests/multi/latest"] });
              void refetch();
            }}
            className="text-sm px-4 py-2 rounded-lg bg-primary text-black font-semibold hover:bg-primary/90"
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {listLoading && <p className="text-muted-foreground">Loading run history…</p>}
        {listError && (
          <p className="text-destructive text-sm">{(listError as Error).message}</p>
        )}

        {!listLoading && !listError && (listData?.runs?.length ?? 0) === 0 && (
          <Card className="glass-panel border-white/10">
            <CardHeader>
              <CardTitle>No archived runs yet</CardTitle>
              <CardDescription>
                Run <code className="text-xs">pnpm --filter @workspace/backtester run backtest -- …</code> once; a
                timestamped JSON file appears in <code className="text-xs">runs/</code>.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        <Card className="glass-panel border-white/10">
          <CardHeader>
            <CardTitle>Historical multi-strategy (Jon-Becker / resolved)</CardTitle>
            <CardDescription>
              Served from{" "}
              <code className="text-xs bg-black/40 px-1 rounded">data/backtest-results/multi/last-ranked.json</code>
              plus timestamped copies and CSV exports in the same folder. Open raw JSON for full equity samples and
              per-sport tables.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {multiLoading && <p className="text-muted-foreground text-sm">Loading multi report…</p>}
            {multiError && (
              <p className="text-muted-foreground text-sm">{(multiError as Error).message}</p>
            )}
            {multiData && !multiLoading && !multiError && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground font-mono">{multiData.generatedAt}</p>
                {multiData.source && (
                  <p className="text-xs text-white/70">
                    {(multiData.source.fromDay as string) ?? "?"} → {(multiData.source.toDay as string) ?? "?"} ·{" "}
                    {String(multiData.source.sportFilter ?? "all")} · {String(multiData.source.mode ?? "")}
                  </p>
                )}
                <div className="max-h-72 overflow-auto border border-white/10 rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-black/80 border-b border-white/10">
                      <tr className="text-left text-muted-foreground">
                        <th className="p-2">#</th>
                        <th className="p-2">Strategy</th>
                        <th className="p-2">PnL</th>
                        <th className="p-2">WR</th>
                        <th className="p-2">Sharpe~</th>
                        <th className="p-2">Trades</th>
                        <th className="p-2">E/trade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {multiData.rankings?.map((r) => (
                        <tr key={r.rank} className="border-b border-white/5">
                          <td className="p-2 text-white/50">{r.rank}</td>
                          <td className="p-2 text-white">{r.strategyName}</td>
                          <td
                            className={`p-2 ${r.totalPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                          >
                            ${r.totalPnlUsd.toFixed(2)}
                          </td>
                          <td className="p-2">{(r.winRate * 100).toFixed(1)}%</td>
                          <td className="p-2">{r.sharpeApprox.toFixed(2)}</td>
                          <td className="p-2">{r.trades}</td>
                          <td className="p-2 text-white/70">
                            ${(r.expectancyPerTradeUsd ?? 0).toFixed(3)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {multiData.suggestedSettingsPatch?.rationale && (
                  <p className="text-xs text-amber-200/90 border border-amber-500/20 rounded-lg p-2 bg-amber-500/5">
                    Settings suggestion: {multiData.suggestedSettingsPatch.rationale}
                  </p>
                )}
                {multiData.outputFiles && (
                  <p className="text-xs text-muted-foreground font-mono break-all">
                    {multiData.outputFiles.summaryCsv && <span>CSV: {multiData.outputFiles.summaryCsv} · </span>}
                    {multiData.outputFiles.tradesCsv && <span>{multiData.outputFiles.tradesCsv}</span>}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {(listData?.runs?.length ?? 0) > 0 && (
          <Card className="glass-panel border-white/10">
            <CardHeader>
              <CardTitle>Run history</CardTitle>
              <CardDescription>Select a backtest to view equity curve and trades.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-col gap-2 max-h-48 overflow-y-auto border border-white/10 rounded-lg p-2 bg-black/20">
                {listData!.runs.map((r) => (
                  <button
                    key={r.runFilename}
                    type="button"
                    onClick={() => setSelectedFile(r.runFilename)}
                    className={`text-left text-sm rounded-md px-3 py-2 transition-colors ${
                      selectedFile === r.runFilename
                        ? "bg-primary/20 text-white border border-primary/50"
                        : "hover:bg-white/5 text-white/80 border border-transparent"
                    }`}
                  >
                    <div className="font-mono text-xs truncate" title={r.runFilename}>
                      {r.runFilename}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      {r.generatedAt && <span>{r.generatedAt}</span>}
                      {r.strategyName && <span>{r.strategyName}</span>}
                      {r.trades != null && <span>{r.trades} trades</span>}
                      {r.totalPnlUsd != null && (
                        <span className={r.totalPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"}>
                          PnL ${r.totalPnlUsd.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {selectedFile && (
          <Card className="glass-panel border-white/10">
            <CardHeader>
              <CardTitle>Selected run</CardTitle>
              <CardDescription className="font-mono text-xs break-all">{selectedFile}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {detailLoading && <p className="text-muted-foreground">Loading details…</p>}
              {detailError && (
                <p className="text-destructive text-sm">{(detailError as Error).message}</p>
              )}
              {detail && !detailLoading && !detailError && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div className="rounded-lg bg-black/30 border border-white/10 p-3">
                      <div className="text-muted-foreground text-xs">Trades</div>
                      <div className="text-lg font-semibold text-white">{detail.metrics.trades}</div>
                    </div>
                    <div className="rounded-lg bg-black/30 border border-white/10 p-3">
                      <div className="text-muted-foreground text-xs">Win rate</div>
                      <div className="text-lg font-semibold text-white">
                        {(detail.metrics.winRate * 100).toFixed(1)}%
                      </div>
                    </div>
                    <div className="rounded-lg bg-black/30 border border-white/10 p-3">
                      <div className="text-muted-foreground text-xs">Total PnL</div>
                      <div
                        className={`text-lg font-semibold ${detail.metrics.totalPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                      >
                        ${detail.metrics.totalPnlUsd.toFixed(2)}
                      </div>
                    </div>
                    <div className="rounded-lg bg-black/30 border border-white/10 p-3">
                      <div className="text-muted-foreground text-xs">Max DD</div>
                      <div className="text-lg font-semibold text-amber-400">
                        {detail.metrics.maxDrawdownPct.toFixed(1)}%
                      </div>
                    </div>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-white mb-2">Equity curve</h3>
                    <div className="h-64 w-full border border-white/10 rounded-lg bg-black/20 p-2">
                      {equityData.length > 0 ? (
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={equityData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                            <XAxis
                              dataKey="label"
                              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }}
                              interval="preserveStartEnd"
                            />
                            <YAxis
                              domain={["auto", "auto"]}
                              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }}
                              tickFormatter={(v) => `$${v}`}
                            />
                            <Tooltip
                              contentStyle={{
                                background: "rgba(0,0,0,0.9)",
                                border: "1px solid rgba(255,255,255,0.15)",
                                borderRadius: 8,
                              }}
                              labelFormatter={(_, payload) => {
                                const row = payload?.[0]?.payload as { t?: number } | undefined;
                                return row?.t ? format(new Date(row.t), "yyyy-MM-dd HH:mm:ss.SSS") : "";
                              }}
                              formatter={(value: number) => [`$${value.toFixed(2)}`, "Equity"]}
                            />
                            <Line
                              type="monotone"
                              dataKey="equity"
                              stroke="hsl(var(--primary))"
                              strokeWidth={2}
                              dot={false}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      ) : (
                        <p className="text-muted-foreground text-sm p-4">No equity points in this file.</p>
                      )}
                    </div>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-white mb-2">
                      Trades
                      {detail.metrics.trades > 0 && (
                        <span className="text-muted-foreground font-normal">
                          {" "}
                          (showing {tradeRows.length} of {detail.metrics.trades}
                          {!detail.trades?.length && detail.tradesPreview?.length ? ", preview only" : ""})
                        </span>
                      )}
                    </h3>
                    <div className="max-h-96 overflow-auto border border-white/10 rounded-lg">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-black/80 backdrop-blur border-b border-white/10">
                          <tr className="text-left text-muted-foreground">
                            <th className="p-2">Time</th>
                            <th className="p-2">Side</th>
                            <th className="p-2">Entry</th>
                            <th className="p-2">PnL</th>
                            <th className="p-2">Result</th>
                            <th className="p-2">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tradeRows.map((tr, i) => (
                            <tr key={`${tr.tsMs}-${i}`} className="border-b border-white/5 hover:bg-white/5">
                              <td className="p-2 whitespace-nowrap text-white/70">
                                {format(new Date(tr.tsMs), "HH:mm:ss")}
                              </td>
                              <td className="p-2 uppercase">{tr.side}</td>
                              <td className="p-2">{tr.entryPrice.toFixed(3)}</td>
                              <td className={`p-2 ${tr.pnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                ${tr.pnlUsd.toFixed(2)}
                              </td>
                              <td className="p-2">{tr.won ? "Win" : "Loss"}</td>
                              <td className="p-2 text-white/60 max-w-[220px] truncate" title={tr.reason}>
                                {tr.reason}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-white">
                      Raw JSON
                    </summary>
                    <pre className="mt-2 font-mono text-white/80 bg-black/40 rounded-lg p-4 overflow-x-auto max-h-64 overflow-y-auto border border-white/10">
                      {JSON.stringify(detail, null, 2)}
                    </pre>
                  </details>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}

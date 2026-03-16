import { useListTrades, useGetTradeStats, getListTradesQueryKey } from "@workspace/api-client-react";
import type { TradeListResponse } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { format } from "date-fns";
import { History, Target, BrainCircuit, BarChart3, TrendingUp, Award } from "lucide-react";
import { useState, useMemo } from "react";
import { ListTradesStatus } from "@workspace/api-client-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, Cell, ReferenceLine
} from "recharts";

export default function Trades() {
  const [filter, setFilter] = useState<ListTradesStatus | 'all'>('all');
  const tradeParams = { limit: 100, status: filter === 'all' ? undefined : filter as ListTradesStatus };

  const { data: tradesData, isLoading: tradesLoading } = useListTrades(
    tradeParams,
    { query: { queryKey: getListTradesQueryKey(tradeParams), placeholderData: (prev: TradeListResponse | undefined) => prev } }
  );

  const { data: stats } = useGetTradeStats();
  const isPositive = (val?: number | null) => (val || 0) >= 0;
  type TradeItem = NonNullable<typeof tradesData>["trades"][number];

  const clvStats = useMemo(() => {
    const trades = tradesData?.trades || [];
    const closedWithClv = trades.filter((t: TradeItem) => t.clv != null && t.status !== "open");
    if (closedWithClv.length === 0) return null;
    const avgClv = closedWithClv.reduce((sum, t) => sum + (t.clv || 0), 0) / closedWithClv.length;
    const positiveClv = closedWithClv.filter((t) => (t.clv || 0) > 0).length;
    const clvHitRate = positiveClv / closedWithClv.length;
    return { avgClv, clvHitRate, count: closedWithClv.length, trades: closedWithClv };
  }, [tradesData]);

  const edgeStats = useMemo(() => {
    const trades = tradesData?.trades || [];
    const closedTrades = trades.filter((t: TradeItem) => t.status === "won" || t.status === "lost");
    if (closedTrades.length === 0) return null;
    const highEdge = closedTrades.filter((t) => t.edge >= 10);
    const highEdgeWins = highEdge.filter((t) => t.status === "won").length;
    const lowEdge = closedTrades.filter((t) => t.edge < 10);
    const lowEdgeWins = lowEdge.filter((t) => t.status === "won").length;
    return {
      highEdgeCount: highEdge.length, highEdgeWinRate: highEdge.length > 0 ? highEdgeWins / highEdge.length : 0,
      lowEdgeCount: lowEdge.length, lowEdgeWinRate: lowEdge.length > 0 ? lowEdgeWins / lowEdge.length : 0,
    };
  }, [tradesData]);

  const clvHistogram = useMemo(() => {
    if (!clvStats?.trades?.length) return [];
    const buckets: Record<string, number> = {};
    const BUCKET_SIZE = 0.02;
    for (const t of clvStats.trades) {
      const v = t.clv || 0;
      const bucket = Math.floor(v / BUCKET_SIZE) * BUCKET_SIZE;
      const label = `${(bucket * 100).toFixed(0)}c`;
      buckets[label] = (buckets[label] || 0) + 1;
    }
    return Object.entries(buckets).sort(([a], [b]) => parseFloat(a) - parseFloat(b)).map(([label, count]) => ({ label, count, positive: parseFloat(label) >= 0 }));
  }, [clvStats]);

  const strategyClv = useMemo(() => {
    const trades = tradesData?.trades || [];
    const map = new Map<string, { name: string; clvSum: number; count: number; pnl: number }>();
    for (const t of trades) {
      if (t.clv == null) continue;
      const key = t.strategyName || "Unknown";
      if (!map.has(key)) map.set(key, { name: key, clvSum: 0, count: 0, pnl: 0 });
      const s = map.get(key)!;
      s.clvSum += t.clv;
      s.count++;
      if (t.pnl) s.pnl += t.pnl;
    }
    return Array.from(map.values())
      .map(s => ({ ...s, avgClv: s.count > 0 ? s.clvSum / s.count : 0 }))
      .sort((a, b) => b.avgClv - a.avgClv);
  }, [tradesData]);

  const clvPnlScatter = useMemo(() => {
    const trades = tradesData?.trades || [];
    return trades
      .filter(t => t.clv != null && t.pnl != null && t.status !== "open")
      .map(t => ({ clv: (t.clv || 0) * 100, pnl: t.pnl || 0, won: t.status === "won", title: t.title }));
  }, [tradesData]);

  const clvLeaderboard = useMemo(() => {
    const trades = tradesData?.trades || [];
    return trades.filter(t => t.clv != null && t.status !== "open")
      .sort((a, b) => (b.clv || 0) - (a.clv || 0))
      .slice(0, 10);
  }, [tradesData]);

  function CustomTooltip({ active, payload, label }: any) {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-card/95 border border-white/10 rounded-lg p-3 text-xs shadow-xl backdrop-blur-sm">
        <div className="font-semibold text-white mb-1">{label ?? payload[0]?.payload?.title}</div>
        {payload.map((p: any) => <div key={p.name} style={{ color: p.color }} className="font-mono">{p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : p.value}</div>)}
      </div>
    );
  }

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-8">
        <div>
          <h2 className="text-3xl font-bold font-display text-white tracking-tight">Trade History</h2>
          <p className="text-muted-foreground mt-1">Full audit log of AI-executed trades and their reasoning.</p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {stats && (
            <>
              <Card className="bg-black/40 border-white/5 shadow-none"><CardContent className="p-4 flex flex-col justify-center h-full">
                <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Win Rate</span>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-white font-mono">{formatPercent(stats.winRate)}</span>
                  <span className="text-xs text-muted-foreground">({stats.wins}W - {stats.losses}L)</span>
                </div>
              </CardContent></Card>
              <Card className="bg-black/40 border-white/5 shadow-none"><CardContent className="p-4 flex flex-col justify-center h-full">
                <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total ROI</span>
                <span className={`text-2xl font-bold font-mono ${isPositive(stats.roi) ? 'text-success' : 'text-destructive'}`}>
                  {isPositive(stats.roi) ? '+' : ''}{formatPercent(stats.roi)}
                </span>
              </CardContent></Card>
              <Card className="bg-black/40 border-white/5 shadow-none"><CardContent className="p-4 flex flex-col justify-center h-full">
                <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Avg Edge Taken</span>
                <span className="text-2xl font-bold text-primary font-mono">{formatPercent(stats.avgEdge)}</span>
              </CardContent></Card>
              <Card className="bg-black/40 border-white/5 shadow-none"><CardContent className="p-4 flex flex-col justify-center h-full">
                <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Current Streak</span>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-white font-mono">{Math.abs(stats.currentStreak)}</span>
                  <span className={`text-xs font-bold ${stats.currentStreak > 0 ? 'text-success' : 'text-destructive'}`}>
                    {stats.currentStreak > 0 ? 'WINS' : 'LOSSES'}
                  </span>
                </div>
              </CardContent></Card>
            </>
          )}
        </div>

        {clvStats && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card className="glass-panel border-white/10">
                <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-primary" />
                    CLV Summary
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="text-center">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Avg CLV</div>
                      <div className={`text-xl font-mono font-bold ${clvStats.avgClv >= 0 ? "text-success" : "text-destructive"}`}>{(clvStats.avgClv * 100).toFixed(2)}c</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">CLV Hit Rate</div>
                      <div className="text-xl font-mono font-bold text-white">{(clvStats.clvHitRate * 100).toFixed(1)}%</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Trades w/ CLV</div>
                      <div className="text-xl font-mono font-bold text-white">{clvStats.count}</div>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 text-center">
                    Positive CLV = closing line moved in your favor after entry. A sign of sharp edge detection.
                  </p>
                </CardContent>
              </Card>

              {edgeStats && (
                <Card className="glass-panel border-white/10">
                  <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Target className="w-4 h-4 text-accent" />
                      Edge Breakdown
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-3 rounded-lg bg-black/30 border border-white/5">
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">High Edge (10%+)</div>
                        <div className={`text-xl font-mono font-bold ${edgeStats.highEdgeWinRate >= 0.5 ? "text-success" : "text-destructive"}`}>{(edgeStats.highEdgeWinRate * 100).toFixed(1)}%</div>
                        <div className="text-[10px] text-muted-foreground">{edgeStats.highEdgeCount} trades</div>
                      </div>
                      <div className="p-3 rounded-lg bg-black/30 border border-white/5">
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Low Edge (&lt;10%)</div>
                        <div className={`text-xl font-mono font-bold ${edgeStats.lowEdgeWinRate >= 0.5 ? "text-success" : "text-destructive"}`}>{(edgeStats.lowEdgeWinRate * 100).toFixed(1)}%</div>
                        <div className="text-[10px] text-muted-foreground">{edgeStats.lowEdgeCount} trades</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            {clvHistogram.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card className="glass-panel border-white/10">
                  <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <BarChart3 className="w-4 h-4 text-primary" />
                      CLV Distribution
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={clvHistogram} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} />
                          <Tooltip content={<CustomTooltip />} />
                          <ReferenceLine x="0c" stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" />
                          <Bar dataKey="count" name="Trades" radius={[2, 2, 0, 0]} maxBarSize={30}>
                            {clvHistogram.map((b) => <Cell key={b.label} fill={b.positive ? "#34d399" : "#f87171"} fillOpacity={0.8} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                {strategyClv.length > 0 && (
                  <Card className="glass-panel border-white/10">
                    <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <TrendingUp className="w-4 h-4 text-accent" />
                        Avg CLV by Strategy
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-4">
                      <div className="h-48">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={strategyClv} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                            <XAxis type="number" tick={{ fill: "#6b7280", fontSize: 9 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v * 100).toFixed(1)}c`} />
                            <YAxis dataKey="name" type="category" tick={{ fill: "#9ca3af", fontSize: 9 }} axisLine={false} tickLine={false} width={70} tickFormatter={(s) => s.split(" ")[0]} />
                            <Tooltip content={<CustomTooltip />} />
                            <ReferenceLine x={0} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 3" />
                            <Bar dataKey="avgClv" name="Avg CLV" radius={[0, 3, 3, 0]} maxBarSize={20}>
                              {strategyClv.map((s) => <Cell key={s.name} fill={s.avgClv >= 0 ? "#34d399" : "#f87171"} fillOpacity={0.85} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {clvPnlScatter.length > 0 && (
              <Card className="glass-panel border-white/10">
                <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Target className="w-4 h-4 text-primary" />
                    CLV vs P&L Scatter
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="h-52">
                    <ResponsiveContainer width="100%" height="100%">
                      <ScatterChart margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="clv" name="CLV" tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} label={{ value: "CLV (cents)", position: "insideBottom", offset: -2, fill: "#6b7280", fontSize: 10 }} />
                        <YAxis dataKey="pnl" name="P&L" tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v.toFixed(0)}`} />
                        <Tooltip content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload;
                          return (
                            <div className="bg-card/95 border border-white/10 rounded-lg p-3 text-xs shadow-xl backdrop-blur-sm">
                              <div className="font-semibold text-white mb-1 max-w-[200px] truncate">{d.title}</div>
                              <div className="font-mono text-muted-foreground">CLV: {d.clv.toFixed(2)}c</div>
                              <div className={`font-mono font-bold ${d.pnl >= 0 ? "text-success" : "text-destructive"}`}>P&L: ${d.pnl.toFixed(2)}</div>
                            </div>
                          );
                        }} />
                        <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                        <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                        <Scatter name="Trades" data={clvPnlScatter}>
                          {clvPnlScatter.map((d, i) => <Cell key={i} fill={d.won ? "#34d399" : "#f87171"} fillOpacity={0.8} />)}
                        </Scatter>
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 text-center mt-2">Green = won · Red = lost · Top-right quadrant = positive CLV + profit (ideal)</p>
                </CardContent>
              </Card>
            )}

            {clvLeaderboard.length > 0 && (
              <Card className="glass-panel border-white/10">
                <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Award className="w-4 h-4 text-yellow-400" />
                    CLV Leaderboard
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y divide-white/5">
                    {clvLeaderboard.map((t, i) => (
                      <div key={t.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02]">
                        <span className={`text-sm font-bold w-5 text-center ${i === 0 ? "text-yellow-400" : i === 1 ? "text-gray-300" : i === 2 ? "text-amber-600" : "text-muted-foreground"}`}>#{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-white truncate">{t.title}</div>
                          <div className="text-[10px] text-muted-foreground">{t.kalshiTicker}</div>
                        </div>
                        <div className="text-right">
                          <div className={`text-sm font-mono font-bold ${(t.clv || 0) >= 0 ? "text-success" : "text-destructive"}`}>{((t.clv || 0) * 100).toFixed(2)}c</div>
                          <div className={`text-[10px] font-mono ${t.pnl ? (isPositive(t.pnl) ? "text-success/70" : "text-destructive/70") : "text-muted-foreground"}`}>
                            {t.pnl ? `P&L: ${isPositive(t.pnl) ? "+" : ""}${formatCurrency(t.pnl)}` : "open"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        <Card className="glass-panel border-white/10">
          <CardHeader className="border-b border-white/5 bg-black/20 flex flex-row items-center justify-between py-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <History className="w-5 h-5 text-muted-foreground" />
              Execution Log
            </CardTitle>
            <div className="flex bg-black/40 p-1 rounded-lg border border-white/5">
              {['all', 'open', 'won', 'lost'].map((f) => (
                <button key={f} onClick={() => setFilter(f as ListTradesStatus | 'all')} className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${filter === f ? 'bg-white/10 text-white' : 'text-muted-foreground hover:text-white'}`}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {tradesLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading trade history...</div>
            ) : !tradesData?.trades?.length ? (
              <div className="p-16 text-center"><p className="text-muted-foreground">No trades found for the selected filter.</p></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-white/[0.02]">
                    <tr>
                      <th className="px-6 py-4 font-semibold">Date</th>
                      <th className="px-6 py-4 font-semibold">Market</th>
                      <th className="px-6 py-4 font-semibold">Side / Size</th>
                      <th className="px-6 py-4 font-semibold text-right">Entry / Exit</th>
                      <th className="px-6 py-4 font-semibold text-right">CLV</th>
                      <th className="px-6 py-4 font-semibold text-right">P&L</th>
                      <th className="px-6 py-4 font-semibold text-center">Status</th>
                      <th className="px-6 py-4 font-semibold text-center">AI Logic</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {tradesData.trades.map((trade) => (
                      <tr key={trade.id} className="hover:bg-white/[0.02] transition-colors group">
                        <td className="px-6 py-4 whitespace-nowrap text-muted-foreground text-xs">{format(new Date(trade.createdAt), "MMM d, HH:mm")}</td>
                        <td className="px-6 py-4 max-w-[250px]">
                          <div className="font-medium text-white mb-1 truncate" title={trade.title}>{trade.title}</div>
                          <div className="text-[10px] font-mono text-muted-foreground">{trade.kalshiTicker}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant={trade.side === 'yes' ? 'success' : 'destructive'} className="text-[10px] h-4">{trade.side.toUpperCase()}</Badge>
                          </div>
                          <div className="text-xs font-mono text-muted-foreground">{trade.quantity} cont.</div>
                        </td>
                        <td className="px-6 py-4 font-mono text-right">
                          <div className="text-white">{formatCurrency(trade.entryPrice)}</div>
                          <div className="text-xs text-muted-foreground">{trade.exitPrice ? formatCurrency(trade.exitPrice) : '—'}</div>
                        </td>
                        <td className={`px-6 py-4 font-mono text-right text-xs ${trade.clv != null ? (trade.clv >= 0 ? 'text-success' : 'text-destructive') : 'text-muted-foreground/40'}`}>
                          {trade.clv != null ? `${(trade.clv * 100).toFixed(2)}c` : '—'}
                        </td>
                        <td className={`px-6 py-4 font-mono font-bold text-right ${trade.pnl ? (isPositive(trade.pnl) ? 'text-success' : 'text-destructive') : 'text-muted-foreground'}`}>
                          {trade.pnl ? `${isPositive(trade.pnl) ? '+' : ''}${formatCurrency(trade.pnl)}` : '—'}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <Badge variant={trade.status === 'won' ? 'success' : trade.status === 'lost' ? 'destructive' : trade.status === 'open' ? 'default' : 'outline'}>
                            {trade.status}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <button className="text-primary hover:text-accent transition-colors" title={trade.analystReasoning || "No reasoning logged"}>
                            <BrainCircuit className="w-5 h-5 mx-auto" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}

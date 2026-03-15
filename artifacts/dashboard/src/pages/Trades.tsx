import { useListTrades, useGetTradeStats, getListTradesQueryKey } from "@workspace/api-client-react";
import type { TradeListResponse } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { format } from "date-fns";
import { History, Target, BrainCircuit, BarChart3 } from "lucide-react";
import { useState, useMemo } from "react";
import { ListTradesStatus } from "@workspace/api-client-react";

export default function Trades() {
  const [filter, setFilter] = useState<ListTradesStatus | 'all'>('all');
  const tradeParams = { limit: 50, status: filter === 'all' ? undefined : filter as ListTradesStatus };
  
  const { data: tradesData, isLoading: tradesLoading } = useListTrades(
    tradeParams,
    { query: { queryKey: getListTradesQueryKey(tradeParams), placeholderData: (prev: TradeListResponse | undefined) => prev } }
  );
  
  const { data: stats } = useGetTradeStats();

  const isPositive = (val?: number | null) => (val || 0) >= 0;

  const clvStats = useMemo(() => {
    const trades = tradesData?.trades || [];
    const closedWithClv = trades.filter((t: any) => t.clv != null && t.status !== "open");
    if (closedWithClv.length === 0) return null;
    const avgClv = closedWithClv.reduce((sum: number, t: any) => sum + (t.clv || 0), 0) / closedWithClv.length;
    const positiveClv = closedWithClv.filter((t: any) => (t.clv || 0) > 0).length;
    const clvHitRate = positiveClv / closedWithClv.length;
    return { avgClv, clvHitRate, count: closedWithClv.length };
  }, [tradesData]);

  const edgeStats = useMemo(() => {
    const trades = tradesData?.trades || [];
    const closedTrades = trades.filter((t: any) => t.status === "won" || t.status === "lost");
    if (closedTrades.length === 0) return null;
    const highEdge = closedTrades.filter((t: any) => t.edge >= 10);
    const highEdgeWins = highEdge.filter((t: any) => t.status === "won").length;
    const highEdgeWinRate = highEdge.length > 0 ? highEdgeWins / highEdge.length : 0;
    const lowEdge = closedTrades.filter((t: any) => t.edge < 10);
    const lowEdgeWins = lowEdge.filter((t: any) => t.status === "won").length;
    const lowEdgeWinRate = lowEdge.length > 0 ? lowEdgeWins / lowEdge.length : 0;
    return { highEdgeCount: highEdge.length, highEdgeWinRate, lowEdgeCount: lowEdge.length, lowEdgeWinRate };
  }, [tradesData]);

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
              <Card className="bg-black/40 border-white/5 shadow-none">
                <CardContent className="p-4 flex flex-col justify-center h-full">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Win Rate</span>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-white font-mono">{formatPercent(stats.winRate)}</span>
                    <span className="text-xs text-muted-foreground">({stats.wins}W - {stats.losses}L)</span>
                  </div>
                </CardContent>
              </Card>
              <Card className="bg-black/40 border-white/5 shadow-none">
                <CardContent className="p-4 flex flex-col justify-center h-full">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total ROI</span>
                  <span className={`text-2xl font-bold font-mono ${isPositive(stats.roi) ? 'text-success' : 'text-destructive'}`}>
                    {isPositive(stats.roi) ? '+' : ''}{formatPercent(stats.roi)}
                  </span>
                </CardContent>
              </Card>
              <Card className="bg-black/40 border-white/5 shadow-none">
                <CardContent className="p-4 flex flex-col justify-center h-full">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Avg Edge Taken</span>
                  <span className="text-2xl font-bold text-primary font-mono">{formatPercent(stats.avgEdge)}</span>
                </CardContent>
              </Card>
              <Card className="bg-black/40 border-white/5 shadow-none">
                <CardContent className="p-4 flex flex-col justify-center h-full">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Current Streak</span>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-white font-mono">{Math.abs(stats.currentStreak)}</span>
                    <span className={`text-xs font-bold ${stats.currentStreak > 0 ? 'text-success' : 'text-destructive'}`}>
                      {stats.currentStreak > 0 ? 'WINS' : 'LOSSES'}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>

        {(clvStats || edgeStats) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {clvStats && (
              <Card className="glass-panel border-white/10">
                <CardHeader className="border-b border-white/5 bg-black/20 py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-primary" />
                    CLV Analytics
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="text-center">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Avg CLV</div>
                      <div className={`text-xl font-mono font-bold ${clvStats.avgClv >= 0 ? "text-success" : "text-destructive"}`}>
                        {(clvStats.avgClv * 100).toFixed(2)}c
                      </div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">CLV Hit Rate</div>
                      <div className="text-xl font-mono font-bold text-white">
                        {(clvStats.clvHitRate * 100).toFixed(1)}%
                      </div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Trades w/ CLV</div>
                      <div className="text-xl font-mono font-bold text-white">{clvStats.count}</div>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 mt-3 text-center">
                    Positive CLV means the closing line moved in your favor after entry — a sign of sharp edge detection.
                  </p>
                </CardContent>
              </Card>
            )}
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
                      <div className={`text-xl font-mono font-bold ${edgeStats.highEdgeWinRate >= 0.5 ? "text-success" : "text-destructive"}`}>
                        {(edgeStats.highEdgeWinRate * 100).toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-muted-foreground">{edgeStats.highEdgeCount} trades</div>
                    </div>
                    <div className="p-3 rounded-lg bg-black/30 border border-white/5">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Low Edge (&lt;10%)</div>
                      <div className={`text-xl font-mono font-bold ${edgeStats.lowEdgeWinRate >= 0.5 ? "text-success" : "text-destructive"}`}>
                        {(edgeStats.lowEdgeWinRate * 100).toFixed(1)}%
                      </div>
                      <div className="text-[10px] text-muted-foreground">{edgeStats.lowEdgeCount} trades</div>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 mt-3 text-center">
                    Win rate comparison by edge size. Higher edge should correlate with better outcomes.
                  </p>
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
                <button
                  key={f}
                  onClick={() => setFilter(f as ListTradesStatus | 'all')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                    filter === f ? 'bg-white/10 text-white' : 'text-muted-foreground hover:text-white'
                  }`}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {tradesLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading trade history...</div>
            ) : !tradesData?.trades?.length ? (
              <div className="p-16 text-center">
                <p className="text-muted-foreground">No trades found for the selected filter.</p>
              </div>
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
                    {tradesData.trades.map((trade: any) => (
                      <tr key={trade.id} className="hover:bg-white/[0.02] transition-colors group">
                        <td className="px-6 py-4 whitespace-nowrap text-muted-foreground text-xs">
                          {format(new Date(trade.createdAt), "MMM d, HH:mm")}
                        </td>
                        <td className="px-6 py-4 max-w-[250px]">
                          <div className="font-medium text-white mb-1 truncate" title={trade.title}>{trade.title}</div>
                          <div className="text-[10px] font-mono text-muted-foreground">{trade.kalshiTicker}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant={trade.side === 'yes' ? 'success' : 'destructive'} className="text-[10px] h-4">
                              {trade.side.toUpperCase()}
                            </Badge>
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
                          <Badge variant={
                            trade.status === 'won' ? 'success' : 
                            trade.status === 'lost' ? 'destructive' : 
                            trade.status === 'open' ? 'default' : 'outline'
                          }>
                            {trade.status}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-center">
                           <button 
                             className="text-primary hover:text-accent transition-colors"
                             title={trade.analystReasoning || "No reasoning logged"}
                           >
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

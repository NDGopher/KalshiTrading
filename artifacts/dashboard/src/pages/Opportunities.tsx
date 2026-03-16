import { useGetMarketOpportunities, useTriggerMarketScan, getGetMarketOpportunitiesQueryKey } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Search, Zap, Clock, TrendingUp, ExternalLink, CheckCircle2, AlertCircle, Info } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useState } from "react";

const API_BASE = `${import.meta.env.BASE_URL}api`;

function kalshiUrl(ticker: string): string {
  const lastDash = ticker.lastIndexOf("-");
  const eventTicker = lastDash !== -1 ? ticker.substring(0, lastDash) : ticker;
  return `https://kalshi.com/markets/${eventTicker}/${ticker}`;
}

function getSkipReason(opp: { confidence: number; edge: number }): string | null {
  if (opp.confidence === 0) return "Claude returned 0% confidence — market too obscure or analysis failed";
  if (opp.confidence < 0.20) return `Auditor rejected: confidence too low (${Math.round(opp.confidence * 100)}% < 20% min)`;
  if (opp.confidence < 0.25) return `Strategy rejected: confidence below Pure Value threshold (${Math.round(opp.confidence * 100)}% < 25%)`;
  if (opp.edge < 3) return `Auditor rejected: insufficient edge (${opp.edge.toFixed(1)}pp < 3pp min)`;
  if (opp.edge < 4) return `Strategy rejected: edge below strategy threshold (${opp.edge.toFixed(1)}pp < 4pp min)`;
  return null;
}

function useOpenTickers() {
  return useQuery({
    queryKey: ["/api/paper-trades/open-tickers"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/paper-trades?limit=200`);
      const data = await res.json();
      const trades: { kalshiTicker: string; status: string }[] = data.trades || data || [];
      return new Set(trades.filter((t) => t.status === "open").map((t) => t.kalshiTicker));
    },
    refetchInterval: 15000,
  });
}

export default function Opportunities() {
  const queryClient = useQueryClient();
  const { data: opportunities, isLoading } = useGetMarketOpportunities({
    query: { queryKey: getGetMarketOpportunitiesQueryKey(), refetchInterval: 15000 }
  });
  const { data: openTickers } = useOpenTickers();
  
  const scanMutation = useTriggerMarketScan({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/markets/opportunities'] });
      }
    }
  });

  const handleScan = () => {
    scanMutation.mutate();
  };

  const traded = opportunities?.filter((o) => openTickers?.has(o.kalshiTicker)) ?? [];
  const skipped = opportunities?.filter((o) => !openTickers?.has(o.kalshiTicker) && (o.confidence < 0.25 || o.edge < 4)) ?? [];
  const pending = opportunities?.filter((o) => !openTickers?.has(o.kalshiTicker) && o.confidence >= 0.25 && o.edge >= 4) ?? [];

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-8">
        
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display text-white tracking-tight">Market Scanner</h2>
            <p className="text-muted-foreground mt-1">Live opportunities analyzed by Claude AI. Click any market ticker to view it on Kalshi.</p>
          </div>
          <Button 
            onClick={handleScan} 
            disabled={scanMutation.isPending}
            className="gap-2 bg-gradient-to-r from-primary to-accent border-0"
          >
            {scanMutation.isPending ? (
              <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            Force Scan Now
          </Button>
        </div>

        {opportunities && opportunities.length > 0 && (
          <div className="grid grid-cols-3 gap-4">
            <div className="glass-panel border border-success/20 bg-success/5 rounded-lg p-4 flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-success flex-shrink-0" />
              <div>
                <div className="text-xl font-bold text-white">{traded.length}</div>
                <div className="text-xs text-muted-foreground">Position Open</div>
              </div>
            </div>
            <div className="glass-panel border border-yellow-500/20 bg-yellow-500/5 rounded-lg p-4 flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0" />
              <div>
                <div className="text-xl font-bold text-white">{skipped.length}</div>
                <div className="text-xs text-muted-foreground">Skipped by Filters</div>
              </div>
            </div>
            <div className="glass-panel border border-primary/20 bg-primary/5 rounded-lg p-4 flex items-center gap-3">
              <TrendingUp className="w-5 h-5 text-primary flex-shrink-0" />
              <div>
                <div className="text-xl font-bold text-white">{pending.length}</div>
                <div className="text-xs text-muted-foreground">Eligible for Trade</div>
              </div>
            </div>
          </div>
        )}

        <Card className="glass-panel border-white/10">
          <CardHeader className="border-b border-white/5 bg-black/20">
            <CardTitle className="text-lg flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              All Analyzed Markets
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading market data...</div>
            ) : !opportunities || opportunities.length === 0 ? (
              <div className="p-16 text-center flex flex-col items-center justify-center">
                <Search className="w-12 h-12 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-medium text-white">No edge found currently</h3>
                <p className="text-muted-foreground mt-1 max-w-md">The scanner is actively monitoring Kalshi sports markets. New opportunities will appear here when EV criteria are met.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs text-muted-foreground uppercase bg-white/[0.02]">
                    <tr>
                      <th className="px-6 py-4 font-semibold">Market</th>
                      <th className="px-6 py-4 font-semibold">Sport</th>
                      <th className="px-6 py-4 font-semibold text-right">Price</th>
                      <th className="px-6 py-4 font-semibold text-right">Model Prob</th>
                      <th className="px-6 py-4 font-semibold text-right text-primary">Est. Edge</th>
                      <th className="px-6 py-4 font-semibold text-right">Confidence</th>
                      <th className="px-6 py-4 font-semibold text-right">Status</th>
                      <th className="px-6 py-4 font-semibold text-right">Closes In</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {opportunities.map((opp) => {
                      const isTraded = openTickers?.has(opp.kalshiTicker);
                      const skipReason = !isTraded ? getSkipReason(opp) : null;
                      const isEligible = !isTraded && !skipReason;
                      return (
                        <tr key={opp.id} className="hover:bg-white/[0.02] transition-colors group">
                          <td className="px-6 py-4">
                            <div className="font-medium text-white mb-1 line-clamp-1">{opp.title}</div>
                            <div className="flex items-center gap-2">
                              <a
                                href={kalshiUrl(opp.kalshiTicker)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
                                title="View on Kalshi"
                              >
                                {opp.kalshiTicker}
                                <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                              </a>
                              <Badge variant={opp.side === 'yes' ? 'success' : 'destructive'} className="text-[10px] px-1.5 py-0 h-4">
                                BUY {opp.side.toUpperCase()}
                              </Badge>
                            </div>
                            {skipReason && (
                              <div className="flex items-center gap-1 mt-1">
                                <Info className="w-3 h-3 text-yellow-400/70 flex-shrink-0" />
                                <span className="text-[10px] text-yellow-400/70">{skipReason}</span>
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <Badge variant="outline" className="bg-white/5">
                              {opp.category}
                            </Badge>
                          </td>
                          <td className="px-6 py-4 font-mono text-right text-white">
                            {formatCurrency(opp.currentYesPrice)}
                          </td>
                          <td className="px-6 py-4 font-mono text-right text-muted-foreground">
                            {formatPercent(opp.modelProbability * 100)}
                          </td>
                          <td className="px-6 py-4 font-mono font-bold text-right text-primary">
                            +{formatPercent(opp.edge)}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                                <div 
                                  className="h-full bg-accent rounded-full" 
                                  style={{ width: `${opp.confidence * 100}%` }}
                                />
                              </div>
                              <span className={`font-mono text-xs w-8 ${opp.confidence < 0.20 ? "text-red-400" : opp.confidence < 0.25 ? "text-yellow-400" : "text-muted-foreground"}`}>
                                {Math.round(opp.confidence * 100)}%
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right">
                            {isTraded ? (
                              <Badge variant="success" className="text-[10px]">
                                <CheckCircle2 className="w-2.5 h-2.5 mr-1" />
                                Position Open
                              </Badge>
                            ) : isEligible ? (
                              <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">
                                Eligible
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px] text-muted-foreground">
                                Filtered Out
                              </Badge>
                            )}
                          </td>
                          <td className="px-6 py-4 text-right text-muted-foreground whitespace-nowrap">
                            <div className="flex items-center justify-end gap-1.5">
                              <Clock className="w-3 h-3" />
                              {formatDistanceToNow(new Date(opp.expiresAt))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
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

import { useGetMarketOpportunities, useTriggerMarketScan } from "@workspace/api-client-react";
import { Layout } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Search, Zap, Clock, TrendingUp } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export default function Opportunities() {
  const queryClient = useQueryClient();
  const { data: opportunities, isLoading } = useGetMarketOpportunities({
    query: { refetchInterval: 15000 }
  });
  
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

  return (
    <Layout>
      <div className="max-w-7xl mx-auto space-y-8">
        
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-bold font-display text-white tracking-tight">Market Scanner</h2>
            <p className="text-muted-foreground mt-1">Live opportunities detected by the AI analyst with positive EV.</p>
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

        <Card className="glass-panel border-white/10">
          <CardHeader className="border-b border-white/5 bg-black/20">
            <CardTitle className="text-lg flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Detected Edge
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
                      <th className="px-6 py-4 font-semibold text-right">Closes In</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {opportunities.map((opp) => (
                      <tr key={opp.id} className="hover:bg-white/[0.02] transition-colors group">
                        <td className="px-6 py-4">
                          <div className="font-medium text-white mb-1 line-clamp-1">{opp.title}</div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono text-muted-foreground">{opp.kalshiTicker}</span>
                            <Badge variant={opp.side === 'yes' ? 'success' : 'destructive'} className="text-[10px] px-1.5 py-0 h-4">
                              BUY {opp.side.toUpperCase()}
                            </Badge>
                          </div>
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
                          +{formatPercent(opp.edge * 100)}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-accent rounded-full" 
                                style={{ width: `${opp.confidence * 100}%` }}
                              />
                            </div>
                            <span className="font-mono text-xs text-muted-foreground w-8">
                              {Math.round(opp.confidence * 100)}%
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-right text-muted-foreground whitespace-nowrap flex items-center justify-end gap-1.5">
                          <Clock className="w-3 h-3" />
                          {formatDistanceToNow(new Date(opp.expiresAt))}
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

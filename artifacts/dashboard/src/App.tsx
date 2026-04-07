import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import Dashboard from "@/pages/Dashboard";
import Opportunities from "@/pages/Opportunities";
import Trades from "@/pages/Trades";
import Agents from "@/pages/Agents";
import Settings from "@/pages/Settings";
import Backtest from "@/pages/Backtest";
import Backtests from "@/pages/Backtests";
import Brain from "@/pages/Brain";
import Paper from "@/pages/Paper";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/opportunities" component={Opportunities} />
      <Route path="/trades" component={Trades} />
      <Route path="/agents" component={Agents} />
      <Route path="/settings" component={Settings} />
      <Route path="/backtest" component={Backtest} />
      <Route path="/backtests" component={Backtests} />
      <Route path="/brain" component={Brain} />
      <Route path="/paper" component={Paper} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

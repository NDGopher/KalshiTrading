import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dashboardRouter from "./dashboard";
import marketsRouter from "./markets";
import tradesRouter from "./trades";
import agentsRouter from "./agents";
import settingsRouter from "./settings";
import backtestRouter from "./backtest";
import costsRouter from "./costs";
import paperTradesRouter from "./paper-trades";
import pmxtBacktestsRouter from "./pmxt-backtests";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dashboardRouter);
router.use(marketsRouter);
router.use(tradesRouter);
router.use(agentsRouter);
router.use(settingsRouter);
router.use(backtestRouter);
router.use(costsRouter);
router.use(paperTradesRouter);
router.use(pmxtBacktestsRouter);

export default router;

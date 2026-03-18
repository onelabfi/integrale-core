export { detectLeaks, generateLeakSummary, generateRootCause } from "./detectionEngine.js";
export { MOCK_CUSTOMERS, MOCK_DEALS, MOCK_INVOICES, MOCK_SUBSCRIPTIONS } from "./mockData.js";
export type {
  ConnectorStatus,
  ConnectorState,
  Customer,
  Deal,
  Invoice,
  Subscription,
  LeakCategory,
  LeakStatus,
  LeakFix,
  RevenueLeak,
  LeakSummary,
  DetectionOutput,
  ScanState,
} from "./types.js";

import type { Resource } from "@modelcontextprotocol/server";
import type { TestConfig } from "./config.js";

export const REVIEW_STATUS_URI = "test://review/status";
export const REVIEW_STATUS_MIME_TYPE = "text/plain";

export const REVIEW_STATUS_RESOURCE: Resource = {
  uri: REVIEW_STATUS_URI,
  name: "Review Status",
  description: "A test resource that changes after subscription.",
  mimeType: REVIEW_STATUS_MIME_TYPE,
};

export interface ReviewStatusState {
  status: string;
  version: number;
  message: string;
}

export function createInitialReviewStatus(config: TestConfig): ReviewStatusState {
  return {
    status: config.initialStatus,
    version: 1,
    message: "Waiting for simulated review result.",
  };
}

export function createUpdatedReviewStatus(config: TestConfig): ReviewStatusState {
  return {
    status: config.updatedStatus,
    version: 2,
    message: "Simulated review result is now available.",
  };
}

export function renderReviewStatus(state: ReviewStatusState): string {
  return [`status: ${state.status}`, `version: ${state.version}`, `message: ${state.message}`].join("\n");
}

export class ReviewStatusStore {
  private state: ReviewStatusState;

  constructor(private readonly config: TestConfig) {
    this.state = createInitialReviewStatus(config);
  }

  get(): ReviewStatusState {
    return this.state;
  }

  /** 次の購読サイクルのために初期状態へ戻す。同一プロセスへ何度でも probe を当てられるようにする。 */
  reset(): ReviewStatusState {
    this.state = createInitialReviewStatus(this.config);
    return this.state;
  }

  markUpdated(): ReviewStatusState {
    this.state = createUpdatedReviewStatus(this.config);
    return this.state;
  }
}

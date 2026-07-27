import axios from 'axios';
import { config } from '../config/config';
import { logger } from '../utils/logger';

export interface SnapshotProposal {
  id: string;
  title: string;
  body: string;
  start: number;
  end: number;
  state: string;
  author: string;
  space: {
    id: string;
    name: string;
  };
}

interface SnapshotResponse {
  data: {
    proposals: SnapshotProposal[];
  };
}

export class SnapshotService {
  private readonly hubUrl: string;
  private readonly space: string;

  constructor() {
    this.hubUrl = config.snapshot.hubUrl;
    this.space = config.snapshot.space;
  }

  /**
   * Fetches new proposals created since the given timestamp.
   * @param sinceTimestamp Unix timestamp (seconds)
   */
  async fetchNewProposals(sinceTimestamp: number): Promise<SnapshotProposal[]> {
    const query = `
      query Proposals($space: String!, $since: Int!) {
        proposals(
          first: 20,
          where: {
            space_in: [$space],
            created_gte: $since
          },
          orderBy: "created",
          orderDirection: asc
        ) {
          id
          title
          body
          start
          end
          state
          author
          space {
            id
            name
          }
        }
      }
    `;

    try {
      const response = await axios.post<SnapshotResponse>(this.hubUrl, {
        query,
        variables: {
          space: this.space,
          since: sinceTimestamp,
        },
      });

      if (response.data.data?.proposals) {
        // Filter out the exact "since" timestamp if needed, but "gte" is fine if we skip duplicates by ID
        return response.data.data.proposals;
      }

      return [];
    } catch (error) {
      logger.error('Failed to fetch Snapshot proposals', {
        space: this.space,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generates a direct link to the proposal on Snapshot.
   */
  getProposalUrl(proposalId: string): string {
    return `https://snapshot.box/#/s:${this.space}/proposal/${proposalId}`;
  }
}

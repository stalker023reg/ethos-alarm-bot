import { ethosClient } from './ethosClient';

export interface EthosUserProfile {
  profileId: string;
  userkey?: string;
  xUsername?: string;
  displayName?: string;
}

export interface EthosUserLookupRequest {
  xUsername: string;
}

export interface EthosUserLookupResponse {
  user: EthosUserProfile | null;
}

/**
 * Resolves an Ethos user profile by X username.
 */
export async function getUserByXUsername(xUsername: string): Promise<EthosUserLookupResponse> {
  const payload: EthosUserLookupRequest = { xUsername };
  const response = await ethosClient.post<EthosUserLookupResponse>('/users/by/x', payload);

  return response.data;
}

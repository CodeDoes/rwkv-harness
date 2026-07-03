import { createORPCClient } from "@orpc/client"
import { RPCLink } from "@orpc/client/fetch"
import type { ContractRouterClient } from "@orpc/contract"
import type { Contract } from "./contract.ts"

export type RpcClient = ContractRouterClient<Contract>

export function createRpcClient(baseUrl: string): RpcClient {
  const link = new RPCLink({ url: baseUrl })
  return createORPCClient(link)
}

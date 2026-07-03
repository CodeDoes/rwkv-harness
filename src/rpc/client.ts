import { createORPCClient } from "@orpc/client"
import { OpenAPILink } from "@orpc/openapi-client/fetch"
import type { ContractRouterClient } from "@orpc/contract"
import type { Contract } from "./contract.ts"
import { contract } from "./contract.ts"

export type RpcClient = ContractRouterClient<Contract>

export function createRpcClient(baseUrl: string): RpcClient {
  const link = new OpenAPILink(contract, { url: baseUrl })
  return createORPCClient(link)
}

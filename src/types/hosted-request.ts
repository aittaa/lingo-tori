import type { SerializableProviderRef } from "@/utils/providers/provider-ref"
export type ProviderRequestRouting<Ref extends SerializableProviderRef = SerializableProviderRef> =
  { providerRef: Ref }

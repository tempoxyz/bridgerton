import { bridge } from './client.js'

export type TransferListParams = {
  limit?: string
  starting_after?: string
  ending_before?: string
  tx_hash?: string
  updated_after_ms?: string
  updated_before_ms?: string
  template_id?: string
  state?: string
}

export type StaticTemplateListParams = {
  limit?: string
  starting_after?: string
  ending_before?: string
}

/** Create a transfer. */
export const createTransfer = (data: Record<string, unknown>) =>
  bridge.post('/transfers', data)

/** Get a transfer by ID. */
export const getTransfer = (id: string) =>
  bridge.get(`/transfers/${id}`)

/** List all transfers. */
export const listTransfers = (params?: TransferListParams) =>
  bridge.get('/transfers', params)

/** Update a transfer. Must be in awaiting_funds state. */
export const updateTransfer = (id: string, data: Record<string, unknown>) =>
  bridge.put(`/transfers/${id}`, data)

/** Delete a transfer. Must be in awaiting_funds state. */
export const deleteTransfer = (id: string) =>
  bridge.delete(`/transfers/${id}`)

/** List all static transfer templates. */
export const listStaticTemplates = (params?: StaticTemplateListParams) =>
  bridge.get('/transfers/static_templates', params)

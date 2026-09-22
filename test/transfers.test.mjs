import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTransferBody } from '../dist/cli.js'

const options = {
  onBehalfOf: 'customer-id',
  sourceRail: 'bridge_wallet',
  sourceCurrency: 'usdc',
  destRail: 'tempo',
  destCurrency: 'usdc',
}

test('omits dry_run by default', () => {
  assert.equal('dry_run' in buildTransferBody(options), false)
  assert.equal('dry_run' in buildTransferBody({ ...options, dryRun: false }), false)
})

test('includes dry_run when requested', () => {
  assert.equal(buildTransferBody({ ...options, dryRun: true }).dry_run, true)
})

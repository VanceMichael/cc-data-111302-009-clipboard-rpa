import {createService} from './serve.mjs';

// 一次完整演示：复制 -> 剪贴板核对 -> 门户真实粘贴 -> 等待清理 -> 回读摘要。
const service = await createService({sanitizeDelay: 150});
const {agent} = service;
try {
  console.log('剪贴板录入演示');
  console.log(JSON.stringify({service: service.url, source: service.sourceUrl, portal: service.portalUrl}, null, 2));
  const created = await agent.createRecord({product: 'P-1', accountant: '资料员甲'});
  console.log('复制与剪贴板核对', JSON.stringify({
    ok: created.ok,
    token: created.record?.copy.token,
    product: created.record?.copy.product,
    version: created.record?.copy.version,
    representations: created.record?.clipboard.representations.types
  }, null, 2));
  const pasted = await agent.paste(created.record.id);
  console.log('粘贴与回读', JSON.stringify({
    status: pasted.record.status,
    adopted: pasted.record.paste.adopted,
    settled: pasted.record.cleanup.settled,
    readback: pasted.record.readback,
    issues: pasted.issues.map(issue => issue.id),
    confirmations: pasted.confirmations.map(item => ({id: item.id, label: item.label}))
  }, null, 2));
} finally {
  await service.close();
}

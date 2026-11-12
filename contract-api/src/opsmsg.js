/**
 * 업무 알림 문구 — 발주 · 환불 · 가발 공동구매 · 내수.
 * 네이버웍스 봇(naverworks-worker buildMessage)과 같은 문구. 앱 '업무 알림' 방에 올릴 글을 만든다.
 * 바꿀 땐 두 곳을 같이 고칠 것.
 */
export function opsText(body) {
  const type = body.type || 'new';
  const order = body.order || {};

  if (type === 'wig') {
    const o = order || {};
    const text = '🧑‍🦱 가발 공동구매 · 주문 가능!\n\n' +
      '📦 업체: ' + (o.vendor || '') + '\n' +
      '🔢 ' + (o.count || 0) + '개 모집 완료 · 참여 ' + (o.people || 0) + '명\n' +
      '👤 개설: ' + (o.createdBy || '') + '\n\n' +
      '→ 경영팀에서 주문 진행해주세요';
    return text;
  }

  if (type === 'naesu') {
    const o = order || {};
    const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';
    const who = (o.name || '') + ' · ' + (o.branch || '');
    // 제목 한 줄로 정상/오류가 바로 구분되게 (알림 미리보기에서 첫 줄만 보임)
    const f = o.flag || 'ok';
    let head, alert = '';
    if (f === 'short') {
      head = '⚠️ 내수 입금 부족 · ' + (o.name || '') + ' ' + won(o.diff) + ' 모자람';
      alert = '⚠️ 입금 ' + won(o.diff) + ' 부족\n   캡처 판독 ' + won(o.paid) + ' / 신청 ' + won(o.total) + '\n';
    } else if (f === 'over') {
      head = '⚠️ 내수 과입금 · ' + (o.name || '') + ' ' + won(o.diff) + ' 더 들어옴';
      alert = '⚠️ ' + won(o.diff) + ' 과입금 — 차액 반환 필요\n   캡처 판독 ' + won(o.paid) + ' / 신청 ' + won(o.total) + '\n';
    } else if (f === 'acct') {
      head = '⚠️ 내수 다른 계좌 입금 · ' + (o.name || '');
      alert = '⚠️ 근무지 계좌가 아닌 곳으로 입금됐어요\n   판독 계좌 ' + (o.readAcct || '읽지 못함') + '\n   근무지 계좌 ' + (o.acct || '') + '\n';
    } else if (f === 'dup') {
      head = '⚠️ 내수 캡처 중복 의심 · ' + (o.name || '');
      alert = '⚠️ 이전 신청에 쓰인 캡처와 같아 보여요\n   이체일시 ' + (o.when || '') + '\n';
    } else if (f === 'filled') {
      head = '✅ 내수 입금 보충 완료 · ' + (o.name || '') + ' ' + won(o.total);
      alert = '✅ 부족했던 차액이 채워졌어요 — 확인해주세요\n   캡처 판독 합계 ' + won(o.paid) + ' / 신청 ' + won(o.total) + '\n';
    } else if (f === 'unread') {
      head = '❓ 내수 캡처 확인 필요 · ' + (o.name || '');
      alert = '❓ 캡처를 자동으로 읽지 못했어요 — 직접 확인해주세요\n';
    } else {
      head = '🧴 내수 신청 · ' + (o.name || '') + ' ' + won(o.total);
      alert = '✅ 입금 ' + won(o.paid || o.total) + ' 일치\n';
    }
    const lines = (Array.isArray(o.items) ? o.items : [])
      .slice(0, 8).map(it => '• ' + (it.n || '') + ' ×' + (it.qty || 1)).join('\n');
    const more = (Array.isArray(o.items) && o.items.length > 8)
      ? '\n  ... 외 ' + (o.items.length - 8) + '품목' : '';
    const text = head + '\n\n' +
      '👤 ' + who + '\n' +
      '🧾 ' + (o.count || 0) + '개 품목 · 총 ' + (o.qty || 0) + '개\n' +
      '💰 신청 ' + won(o.total) + '\n\n' +
      alert +
      (lines ? '\n' + lines + more + '\n' : '') +
      '\n🕐 ' + (o.date || '') + ' ' + (o.time || '') +
      '\n\n→ 본사 시스템에서 확인해주세요';
    return text;
  }

  let title;
  if (type === 'test') title = '✅ 테스트 메시지';
  else if (type === 'refund') title = '💰 환불 요청이 들어왔어요';
  else title = '🔔 새 발주가 들어왔어요!';

  // 제품명 대신 거래처별로 묶어서 표시 (제품/비품 모두 items[].supplier 사용)
  let itemList = '';
  if (order.items && typeof order.items === 'object') {
    const items = Object.values(order.items);
    const bySup = {};
    items.forEach(it => {
      const sup = (it.supplier || '').trim() || '거래처 미지정';
      if (!bySup[sup]) bySup[sup] = { qty: 0, kinds: 0 };
      bySup[sup].qty += Number(it.qty) || 0;
      bySup[sup].kinds += 1;
    });
    const rows = Object.keys(bySup)
      .map(s => ({ sup: s, qty: bySup[s].qty, kinds: bySup[s].kinds }))
      .sort((a, b) => b.qty - a.qty);
    itemList = rows.slice(0, 8)
      .map(r => '• ' + r.sup + ' ' + r.qty + '개' + (r.kinds > 1 ? ' (' + r.kinds + '품목)' : ''))
      .join('\n');
    if (rows.length > 8) itemList += '\n  ... 외 ' + (rows.length - 8) + '개 거래처';
  }

  let text = title;
  if (type === 'test') {
    text += '\n\n네이버 웍스 봇 연결이 정상입니다 👍';
  } else {
    text += '\n\n' +
      '📍 ' + (order.brand || '') + ' ' + (order.branch || '') + '\n' +
      '👤 신청자: ' + (order.orderedBy || '') + '\n' +
      '📦 ' + (order.type ? order.type + ' · ' : '') + '총 ' + (order.itemCount || 0) + '개 항목\n' +
      (itemList ? '\n' + itemList + '\n' : '') +
      (order.note ? '\n📝 메모: ' + order.note + '\n' : '') +
      '\n🕐 ' + (order.date || '') + ' ' + (order.time || '') +
      '\n\n→ 본사 시스템에서 확인하기';
  }

  return text;
}

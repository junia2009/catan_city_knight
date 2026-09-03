// 描き替えの小道具。DOM の細かい作法をここに閉じる。

// innerHTML を「中身が変わったときだけ」書く。
//
// 同じ文字列でも代入すれば中の節点は全部作り直される。押せるものが
// 入っている箱でこれをやると、**指で押せなくなる** ── iOS の Safari は
// touchstart と touchend が同じ節点でないと click を出さないので、
// 押している 100ms ほどの間に作り直されると、そのタップは消える。
// (受付のパネルが秒10回作り直されていて、実機で「ボタンは出るのに
//  押せない。連打するとたまに入る」という状態になっていた)
//
// 前に書いた文字列は要素ごとに覚えておく。innerHTML を読み返して比べると、
// ブラウザが直した書き方(属性の順や引用符)との差でいつも「変わった」に
// なってしまい、番人として働かない。
const last = new WeakMap();

export function setHTML(el, html) {
  if (!el) return false;
  if (last.get(el) === html) return false;
  last.set(el, html);
  el.innerHTML = html;
  return true;
}

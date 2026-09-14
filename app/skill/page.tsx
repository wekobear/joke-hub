export const metadata = { title: "Skill 使用教程 · 每日笑话" };

function RouteCard({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card" id={id} style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 10px", fontSize: 17 }}>{title}</h2>
      {children}
    </section>
  );
}

export default function SkillPage() {
  return (
    <main className="container">
      <h1 className="page-title">daily-jokes Skill 使用教程</h1>
      <p className="subtitle">
        一句话让 AI 帮你读笑话，或者把笑话做成图文视频。按你的用途选一条路线即可。
      </p>

      <div className="page-body">
        <nav className="toc" aria-label="目录">
          <a href="#route-a">A · 只看每日笑话</a>
          <a href="#route-b">B · 制作图文视频</a>
          <a href="#install">安装</a>
          <a href="#examples">案例播放</a>
        </nav>

        <div className="content" style={{ maxWidth: 640 }}>
          <RouteCard id="route-a" title="路线 A：只看每日笑话">
            <p>
              想看今天的笑话时，直接对 AI 说一句就行，比如：
            </p>
            <p className="cmd">$jokes 只看今天的笑话，不做图片和视频</p>
            <p>
              Skill 会帮你找今天的更新，读完就算完，不会生成图片或视频。
              也可以让它换一批、只看短的、或者挑一则讲细一点。
            </p>
          </RouteCard>

          <RouteCard id="route-b" title="路线 B：制作图文视频">
            <p>
              想把某则笑话做成能发出去的图文或视频，也只要一句话：
            </p>
            <p className="cmd">$jokes 把第二则做成图文，暂不调用视频API</p>
            <p>
              Skill 会先排出画面，再决定要不要动用视频生成。
              上面的例子只做图文，暂时不调用视频 API；
              如果你想出视频，直接说明即可。
            </p>
          </RouteCard>

          <RouteCard id="install" title="安装">
            <p>
              点击下方按钮下载 Skill 包（zip 下载后不会自动安装），然后：
            </p>
            <ol>
              <li>解压 zip，得到完整的 jokes 文件夹；</li>
              <li>把这个文件夹整个放到你宿主的 Skill 目录；</li>
              <li>重新开始一个会话，就能用 $jokes 调用了。</li>
            </ol>
            <p>
              <a className="btn primary" href="/downloads/jokes-v0.5.0.zip" download>
                下载 jokes-v0.5.0.zip
              </a>
            </p>
          </RouteCard>

          <RouteCard id="examples" title="案例播放">
            <p>两个真实做出来的例子，感受一下路线 B 的效果：</p>
            <p style={{ fontWeight: 600, marginBottom: 6 }}>阿凡提种金子 · 配音图文视频</p>
            <video
              controls
              preload="metadata"
              src="/examples/afanti-demo.mp4"
              style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)" }}
            />
            <p style={{ fontWeight: 600, margin: "18px 0 6px" }}>H3 试镜 · 真实 H3 单镜试片</p>
            <video
              controls
              preload="metadata"
              src="/examples/h3-trial.mp4"
              style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)" }}
            />
          </RouteCard>
        </div>
      </div>
    </main>
  );
}

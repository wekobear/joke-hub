import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants, Card } from "@heroui/react";

export const metadata = { title: "Skill 使用教程 · 每日笑话" };

function RouteCard({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <Card>
        <Card.Header>
          <Card.Title className="text-[17px]">{title}</Card.Title>
        </Card.Header>
        <Card.Content className="mt-2">
          <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-foreground/80">
            {children}
          </div>
        </Card.Content>
      </Card>
    </section>
  );
}

function Cmd({ children }: { children: string }) {
  return (
    <code className="overflow-x-auto rounded-lg bg-surface-secondary px-3.5 py-2.5 font-mono text-sm text-accent">
      {children}
    </code>
  );
}

export default function SkillPage() {
  return (
    <main className="container pb-20">
      <h1 className="mt-4 mb-1 text-[22px] font-semibold">
        daily-jokes Skill 使用教程
      </h1>
      <p className="mb-6 text-sm text-muted">
        一句话让 AI 帮你读笑话，或者把笑话做成图文视频。按你的用途选一条路线即可。
      </p>

      <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-10">
        <nav
          aria-label="目录"
          className="flex gap-2.5 overflow-x-auto text-[13.5px] whitespace-nowrap [scrollbar-width:none] lg:sticky lg:top-24 lg:w-[170px] lg:shrink-0 lg:flex-col lg:overflow-visible lg:whitespace-normal"
        >
          <a href="#route-a" className="shrink-0 py-1 text-muted hover:text-accent">
            A · 只看每日笑话
          </a>
          <a href="#route-b" className="shrink-0 py-1 text-muted hover:text-accent">
            B · 制作图文视频
          </a>
          <a href="#install" className="shrink-0 py-1 text-muted hover:text-accent">
            安装
          </a>
          <a href="#examples" className="shrink-0 py-1 text-muted hover:text-accent">
            案例播放
          </a>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-5 lg:max-w-[640px]">
          <RouteCard id="route-a" title="路线 A：只看每日笑话">
            <p>想看今天的笑话时，直接对 AI 说一句就行，比如：</p>
            <Cmd>$jokes 只看今天的笑话，不做图片和视频</Cmd>
            <p>
              Skill 会帮你找今天的更新，读完就算完，不会生成图片或视频。
              也可以让它换一批、只看短的、或者挑一则讲细一点。
            </p>
          </RouteCard>

          <RouteCard id="route-b" title="路线 B：制作图文视频">
            <p>想把某则笑话做成能发出去的图文或视频，也只要一句话：</p>
            <Cmd>$jokes 把第二则做成图文，暂不调用视频API</Cmd>
            <p>
              Skill 会先排出画面，再决定要不要动用视频生成。
              上面的例子只做图文，暂时不调用视频 API；
              如果你想出视频，直接说明即可。
            </p>
          </RouteCard>

          <RouteCard id="install" title="安装">
            <p>点击下方按钮下载 Skill 包（zip 下载后不会自动安装），然后：</p>
            <ol className="list-decimal space-y-1.5 pl-5 marker:text-muted">
              <li>解压 zip，得到完整的 jokes 文件夹；</li>
              <li>把这个文件夹整个放到你宿主的 Skill 目录；</li>
              <li>重新开始一个会话，就能用 $jokes 调用了。</li>
            </ol>
            <p>
              <Link
                href="/downloads/jokes-v0.5.0.zip"
                download
                className={buttonVariants({ variant: "primary" })}
              >
                下载 jokes-v0.5.0.zip
              </Link>
            </p>
          </RouteCard>

          <RouteCard id="examples" title="案例播放">
            <p>两个真实做出来的例子，感受一下路线 B 的效果：</p>
            <p className="font-semibold">阿凡提种金子 · 配音图文视频</p>
            <video
              controls
              preload="metadata"
              src="/examples/afanti-demo.mp4"
              className="w-full rounded-lg border border-border"
            />
            <p className="mt-2 font-semibold">H3 试镜 · 真实 H3 单镜试片</p>
            <video
              controls
              preload="metadata"
              src="/examples/h3-trial.mp4"
              className="w-full rounded-lg border border-border"
            />
          </RouteCard>
        </div>
      </div>
    </main>
  );
}

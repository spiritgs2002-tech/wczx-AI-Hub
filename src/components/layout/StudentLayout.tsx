"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Layout as TLayout } from "tdesign-react";
import { LogoutIcon, UserIcon } from "tdesign-icons-react";

const { Header, Content } = TLayout;

interface StudentUser {
  name: string;
}

export default function StudentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [user, setUser] = useState<StudentUser | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (stored) {
      const parsedUser = JSON.parse(stored);
      setUser(parsedUser);
    } else {
      router.push("/student");
    }
  }, [router]);

  // 平板 Firefox 对 dvh 的支持依版本而异（旧版仍需 JS 兜底）。
  // 把浏览器报告的可视高度写成 CSS 变量，聊天页据此算高度，避免地址栏把底部输入区顶出屏幕。
  useEffect(() => {
    const apply = () => {
      document.documentElement.style.setProperty("--student-vh", `${window.innerHeight}px`);
    };
    apply();
    window.addEventListener("resize", apply);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      vv?.removeEventListener("resize", apply);
    };
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    router.push("/student");
  };

  return (
    <TLayout className="min-h-screen bg-[#F3F6F9]">
      {/* 顶部导航栏 */}
      <Header className="bg-white border-b border-gray-200 px-6 flex items-center justify-between h-12" style={{ height: "48px" }}>
        <h2 className="text-lg font-bold text-[#00A870] whitespace-nowrap">WenChang SmartFusion</h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-[#63666F]">
            <UserIcon />
            <span>{user?.name}</span>
          </div>
          <Button
            theme="default"
            variant="text"
            size="small"
            icon={<LogoutIcon />}
            onClick={handleLogout}
          >
            退出
          </Button>
        </div>
      </Header>
      {/* 内容区 */}
      <Content className="px-4 py-3">{children}</Content>

    </TLayout>
  );
}

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

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    router.push("/student");
  };

  return (
    <TLayout className="min-h-screen bg-[#F3F6F9]">
      {/* 顶部导航栏 */}
      <Header className="bg-white border-b border-gray-200 px-6 flex items-center justify-between h-14" style={{ height: "56px" }}>
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
      <Content className="p-4">{children}</Content>

    </TLayout>
  );
}

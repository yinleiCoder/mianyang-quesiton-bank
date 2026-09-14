import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  // 各页只写短标题（如「工作台」），由模板补站点名
  title: {
    default: "绵阳市中职共建题库",
    template: "%s · 绵阳市中职共建题库",
  },
  description: "多校共建 · 全市共享的中职题库系统",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <TooltipProvider>
          {children}
          <Toaster richColors position="top-center" closeButton />
        </TooltipProvider>
      </body>
    </html>
  );
}

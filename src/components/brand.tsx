import Image from "next/image";

export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <Image
      className={`brand-mark ${className}`}
      src="/brand/safe-online-exam-icon.png"
      alt="Safe Online Exam logo"
      width={192}
      height={192}
      unoptimized
    />
  );
}

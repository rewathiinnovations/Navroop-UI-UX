type CreditDenial = {
  reason: string;
  used: number;
  limit: number;
  message: string;
};

function ranOutLabel(reason: string) {
  if (reason === 'paused') return 'Generation paused';
  if (reason === 'member_cap') return 'Personal credit limit';
  if (reason === 'projects') return 'Project limit';
  if (reason === 'members') return 'Member limit';
  if (reason === 'storage') return 'Storage limit';
  return 'Workspace credits';
}

export default function CreditLimitPanel({ denial }: { denial: CreditDenial }) {
  return (
    <div
      className="max-w-[92%] rounded-16 border border-amber-200 bg-amber-50 px-16 py-14 text-[13px] leading-5 text-amber-950"
      role="status"
    >
      <p className="font-medium">{denial.message}</p>
      <p className="mt-6 text-[12px] text-amber-900/80">
        {ranOutLabel(denial.reason)}: {denial.used} / {denial.limit}
      </p>
      <p className="mt-10 text-[13px] font-medium text-amber-950">Talk to an admin</p>
    </div>
  );
}

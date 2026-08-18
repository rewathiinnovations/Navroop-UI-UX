import { describeSettings } from '@/lib/settings/resolve';
import ConfigAdmin from './ConfigAdmin';

export default async function AdminConfigPage() {
  const { groups, settings, bootstrap } = await describeSettings();
  return (
    <ConfigAdmin
      initialGroups={groups.map((group) => ({ ...group }))}
      initialSettings={settings}
      initialBootstrap={bootstrap}
    />
  );
}

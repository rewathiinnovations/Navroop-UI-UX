import { animate } from 'motion';
import { motion } from 'motion/react';
import { useMemo, useRef, useState } from 'react';

import { cn } from '@/utils/cn';

export type Props = {
  tabs: {
    value: string;
    label: string;
    description?: string;
    icon?: React.ReactNode;
    children?: React.ReactNode;
    /**
     * `id` of the panel this tab controls, when the consumer renders one. Left
     * out, no `aria-controls` is emitted rather than a dangling reference — the
     * panels live outside this component.
     */
    panelId?: string;
  }[];
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /** Names the tablist for assistive tech. */
  label?: string;
  position?: 'left' | 'center';
  itemButtonClassName?: string;
  itemClassName?: string;
  noScroll?: boolean;
};

/**
 * A row of plain `<button>`s announced nothing but "button, button, button" and
 * moved only on Tab. It now carries the same semantics as
 * `components/admin/AdminTabs.tsx`: `tablist`/`tab`, `aria-selected`, a roving
 * `tabIndex` so the group is one stop, and Arrow/Home/End movement.
 */
export default function Tabs({
  tabs,
  activeTab,
  setActiveTab,
  label = 'Sections',
  position = 'left',
  itemButtonClassName,
  itemClassName,
  noScroll,
}: Props) {
  const backgroundRef = useRef<HTMLDivElement>(null);
  const activeIndex = useMemo(
    () => tabs.findIndex((tab) => tab.value === activeTab),
    [tabs, activeTab],
  );

  const [styles, setStyles] = useState<{
    x: number;
    width: number;
  }>({
    x: 0,
    width: 0,
  });
  /**
   * Arrow/Home/End move selection and focus together, which is the automatic
   * activation pattern the admin tabs already use. Ids are derived from
   * `tab.value`, so a tab keeps its identity when the list is reordered.
   */
  const tabId = (value: string) => `tab-${value}`;
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    let next: number;
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else return;
    event.preventDefault();
    setActiveTab(tabs[next].value);
    document.getElementById(tabId(tabs[next].value))?.focus();
  };

  return (
    <div
      className={cn(
        'overflow-x-scroll whitespace-nowrap hide-scrollbar lg:contents py-32 -my-32',
        noScroll && '!contents',
      )}
    >
      <div
        role="tablist"
        aria-label={label}
        className={cn('flex relative', position === 'center' && 'lg:justify-center')}
      >
        {styles.width !== 0 && (
          <motion.div
            animate={styles}
            className="absolute top-12 left-0 z-[2] inset-y-12 bg-white-alpha-72 rounded-full backdrop-blur-4"
            initial={styles}
            ref={backgroundRef}
            style={{
              boxShadow:
                '0px 24px 32px -12px rgba(0, 0, 0, 0.03), 0px 16px 24px -8px rgba(0, 0, 0, 0.03), 0px 8px 16px -4px rgba(0, 0, 0, 0.03), 0px 0px 0px 1px rgba(0, 0, 0, 0.03)',
            }}
            transition={{
              type: 'spring',
              stiffness: 250,
              damping: 26,
            }}
          />
        )}

        {tabs.map((tab, index) => (
          <div className={cn('relative p-12 group', itemClassName)} key={tab.value}>
            <div className="h-full w-1 right-0 absolute bg-border-faint top-0" />
            {position === 'center' && (
              <div className="h-full w-1 -left-1 lg-max:hidden absolute bg-border-faint top-0" />
            )}

            <button
              type="button"
              id={tabId(tab.value)}
              role="tab"
              aria-selected={activeTab === tab.value}
              {...(tab.panelId ? { 'aria-controls': tab.panelId } : {})}
              tabIndex={activeTab === tab.value ? 0 : -1}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                'py-12 px-24 flex gap-4 justify-center items-center w-full relative z-[3] transition-colors',
                activeTab === tab.value
                  ? 'text-accent-black'
                  : 'text-black-alpha-64 hover:text-black-alpha-88 hover:before:opacity-100',
                'inside-border before:border-border-faint before:opacity-0 rounded-full before:scale-[0.98] hover:before:scale-100',
                itemButtonClassName,
              )}
              data-active={activeTab === tab.value}
              ref={(element) => {
                if (element && index === activeIndex) {
                  const target = element.closest('.group') as HTMLButtonElement;
                  const width = target.offsetWidth;

                  setStyles({
                    x: target.offsetLeft + 12,
                    width: width - 24,
                  });
                }
              }}
              onClick={(e) => {
                setActiveTab(tab.value);

                const t = e.target as HTMLElement;

                let target =
                  t instanceof HTMLButtonElement ? t : (t.closest('button') as HTMLButtonElement);
                target = target.closest('.group') as HTMLButtonElement;

                if (backgroundRef.current) {
                  animate(backgroundRef.current, { scale: 0.96 }).then(() =>
                    animate(backgroundRef.current!, { scale: 1 }),
                  );

                  setStyles({
                    x: target.offsetLeft + 12,
                    width: target.offsetWidth - 24,
                  });
                }

                if (window.innerWidth < 996) {
                  const parent = backgroundRef.current!.parentElement!
                    .parentElement as HTMLDivElement;

                  parent.scrollTo({
                    left: target.offsetLeft - target.clientWidth / 2,
                    behavior: 'smooth',
                  });
                }
              }}
            >
              {tab.icon}

              <div className="px-4 text-label-medium">{tab.label}</div>

              {tab.children}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

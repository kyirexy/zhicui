import Link from 'next/link';
import type { ReactNode } from 'react';
import { LEGAL_EFFECTIVE_DATE, PUBLIC_INFORMATION_LINKS } from '@/lib/legalDocuments';
import styles from './PublicDocumentPage.module.css';

export interface PublicDocumentSection {
  id: string;
  title: string;
  content: ReactNode;
}

interface PublicDocumentPageProps {
  category: string;
  title: string;
  version: string;
  effectiveDate?: string;
  intro: string;
  sections: PublicDocumentSection[];
}

export default function PublicDocumentPage({
  category,
  title,
  version,
  effectiveDate = LEGAL_EFFECTIVE_DATE,
  intro,
  sections,
}: PublicDocumentPageProps) {
  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <article className={styles.article}>
          <p className={styles.eyebrow}>{category}</p>
          <h1>{title}</h1>
          <div className={styles.meta}>
            <span>版本：{version}</span>
            <span>生效日期：{effectiveDate}</span>
          </div>
          <p className={styles.intro}>{intro}</p>
          {sections.map((section) => (
            <section key={section.id} id={section.id} className={styles.section}>
              <h2>{section.title}</h2>
              {section.content}
            </section>
          ))}
        </article>

        <aside className={styles.aside} aria-label="公共信息导航">
          <strong>公共信息</strong>
          <nav>
            {PUBLIC_INFORMATION_LINKS.map((item) => (
              <Link key={item.href} href={item.href}>{item.label}</Link>
            ))}
          </nav>
        </aside>
      </div>
    </main>
  );
}

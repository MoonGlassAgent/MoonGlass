import { useState } from 'react'
import { Check, Copy, ExternalLink, Mail, ShieldCheck } from 'lucide-react'
import { APP_INFO } from '@shared/app-info'
import logoUrl from '../assets/logo.png'
import wechatContactUrl from '../assets/wechat-commercial-contact.jpg'
import { useTranslation, type MessageKey } from '../i18n'

const FLOW: ReadonlyArray<{ number: string; titleKey: MessageKey; descriptionKey: MessageKey }> = [
  { number: '1', titleKey: 'information.flow.step1.title', descriptionKey: 'information.flow.step1.description' },
  { number: '2', titleKey: 'information.flow.step2.title', descriptionKey: 'information.flow.step2.description' },
  { number: '3', titleKey: 'information.flow.step3.title', descriptionKey: 'information.flow.step3.description' },
  { number: '4', titleKey: 'information.flow.step4.title', descriptionKey: 'information.flow.step4.description' },
  { number: '5', titleKey: 'information.flow.step5.title', descriptionKey: 'information.flow.step5.description' },
  { number: '6', titleKey: 'information.flow.step6.title', descriptionKey: 'information.flow.step6.description' }
]

export function InformationPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copyEmail = async (): Promise<void> => {
    await navigator.clipboard.writeText(APP_INFO.contactEmail)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="h-full overflow-y-auto bg-zinc-50">
      <header className="border-b border-zinc-200 bg-white px-8 py-6">
        <div className="flex items-center gap-4">
          <img src={logoUrl} alt="MoonGlass" className="size-16 rounded-lg" />
          <div>
            <h1 className="text-2xl font-bold text-zinc-900">{APP_INFO.name}</h1>
            <p className="mt-1 text-sm text-zinc-500">{t('information.versionTagline', { version: APP_INFO.version })}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-8 py-7">
        <section>
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck size={19} className="text-emerald-600" />
            <h2 className="text-lg font-semibold text-zinc-900">{t('information.license.title')}</h2>
          </div>
          <div className="grid gap-4 border-y border-zinc-200 bg-white px-5 py-5 md:grid-cols-2">
            <div>
              <div className="text-sm font-semibold text-zinc-800">Source Available</div>
              <p className="mt-2 text-sm leading-6 text-zinc-600">
                {t('information.license.sourceAvailableDesc')}
              </p>
              <a
                href={APP_INFO.licenseUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800"
              >
                {t('information.license.viewLicense', { name: APP_INFO.licenseName })}<ExternalLink size={14} />
              </a>
            </div>
            <div className="border-t border-zinc-200 pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
              <div className="text-sm font-semibold text-zinc-800">{t('information.license.commercialTitle')}</div>
              <p className="mt-2 text-sm leading-6 text-zinc-600">
                {t('information.license.commercialDesc')}
              </p>
              <p className="mt-3 text-xs leading-5 text-zinc-500">
                {t('information.license.ownershipNote')}
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold text-zinc-900">{t('information.manual.title')}</h2>
          <div className="grid gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 md:grid-cols-2 lg:grid-cols-3">
            {FLOW.map(({ number, titleKey, descriptionKey }) => (
              <div key={number} className="min-h-32 bg-white p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">{number}</span>
                  <h3 className="text-sm font-semibold text-zinc-800">{t(titleKey)}</h3>
                </div>
                <p className="text-sm leading-6 text-zinc-600">{t(descriptionKey)}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 border-l-2 border-emerald-500 bg-emerald-50 px-4 py-3 text-sm leading-6 text-zinc-700">
            {t('information.manual.tip')}
          </div>
        </section>

        <section className="grid gap-7 border-t border-zinc-200 pt-7 md:grid-cols-[1fr_220px]">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">{t('information.support.title')}</h2>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              {t('information.support.description')}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-zinc-800"><Mail size={16} />{APP_INFO.contactEmail}</span>
              <button
                type="button"
                onClick={() => void copyEmail()}
                className="inline-flex size-8 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-100"
                title={t('information.support.copyEmail')}
                aria-label={t('information.support.copyEmail')}
              >
                {copied ? <Check size={15} className="text-emerald-600" /> : <Copy size={15} />}
              </button>
            </div>
            <div className="mt-5 text-xs leading-5 text-zinc-500">
              {t('information.support.privacyNote')}
            </div>
          </div>
          <figure className="text-center">
            <img src={wechatContactUrl} alt={t('information.support.qrAlt')} className="mx-auto w-44 border border-zinc-200 bg-white p-2" />
            <figcaption className="mt-2 text-xs text-zinc-500">{t('information.support.qrCaption')}</figcaption>
          </figure>
        </section>
      </main>
    </div>
  )
}

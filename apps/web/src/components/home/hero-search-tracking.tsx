'use client'

import { useEffect } from 'react'

import { useLocalToolLibrary } from '@/components/local-library/local-tool-library-provider'
import { reportToolSubmission } from '@/lib/tool-submission'

/**
 * The vendored hero search form is a plain GET form that carries `data-wanmi-tool`.
 * This listener gives its submissions the same local-history and analytics side
 * effects as DomainQueryForm without the baseline importing anything from the app.
 */
export function HeroSearchTracking() {
  const { recordHistory } = useLocalToolLibrary()

  useEffect(() => {
    function onSubmit(event: SubmitEvent) {
      const form = event.target
      if (!(form instanceof HTMLFormElement) || form.dataset.wanmiTool !== 'domain-search') return
      reportToolSubmission(form, 'domain-search', recordHistory)
    }
    document.addEventListener('submit', onSubmit)
    return () => document.removeEventListener('submit', onSubmit)
  }, [recordHistory])

  return null
}

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { PropertySort } from '@elastic/eui';
import { isArray, isObject } from 'lodash';
import get from 'lodash/get';
import omitBy from 'lodash/omitBy';
import round from 'lodash/round';
import moment from 'moment';
import { HttpSetup } from '../../../../../../src/core/public';
import { TRACE_ANALYTICS_DATE_FORMAT } from '../../../../common/constants/trace_analytics';
import { TraceAnalyticsMode, TraceQueryMode } from '../../../../common/types/trace_analytics';
import { coreRefs } from '../../../../public/framework/core_refs';
import { Span, ParsedHit, HierarchicalSpan } from '../components/common/constants';
import {
  microToMilliSec,
  nanoToMilliSec,
  parseIsoToNano,
} from '../components/common/helper_functions';
import { SpanSearchParams } from '../components/traces/span_detail_table';
import {
  getCustomIndicesTracesQuery,
  getPayloadQuery,
  getSpanFlyoutQuery,
  getSpansQuery,
  getTraceGroupPercentilesQuery,
  getTracesQuery,
} from './queries/traces_queries';
import { handleDslRequest } from './request_handler';

export const handleCustomIndicesTracesRequest = async (
  http: HttpSetup,
  DSL: any,
  items: any,
  setItems: (items: any) => void,
  mode: TraceAnalyticsMode,
  pageIndex: number = 0,
  pageSize: number = 10,
  setTotalHits: any,
  dataSourceMDSId?: string,
  sort?: PropertySort,
  queryMode?: TraceQueryMode,
  isUnderOneHour?: boolean
) => {
  try {
    const response = await handleDslRequest(
      http,
      DSL,
      getCustomIndicesTracesQuery(
        mode,
        undefined,
        pageIndex,
        pageSize,
        sort,
        queryMode,
        isUnderOneHour
      ),
      mode,
      dataSourceMDSId
    );

    const hits = response?.hits?.hits || [];
    const totalHits = response?.hits?.total?.value ?? 0;

    setTotalHits(totalHits);

    if (!hits.length) {
      setItems([]);
      return;
    }

    if (mode === 'data_prepper' || mode === 'custom_data_prepper') {
      const keys = new Set();
      const results = hits.map((val) => {
        const source = omitBy(val._source, isArray || isObject);
        Object.keys(source).forEach((key) => keys.add(key));
        return { ...source };
      });

      setItems(results);
    } else {
      const buckets = response?.aggregations?.traces?.buckets || [];
      const results = buckets.map((bucket: any) => ({
        trace_id: bucket.key,
        latency: bucket.latency.value,
        last_updated: moment(bucket.last_updated.value).format(TRACE_ANALYTICS_DATE_FORMAT),
        error_count: bucket.error_count.doc_count,
        actions: '#',
      }));
      setItems(results);
    }
  } catch (error) {
    console.error('Error in handleCustomIndicesTracesRequest:', error);
    coreRefs.core?.notifications.toasts.addError(error, {
      title: 'Failed to retrieve custom indices traces',
      toastLifeTimeMs: 10000,
    });
  }
};

export const handleTracesRequest = async (
  http: HttpSetup,
  DSL: any,
  timeFilterDSL: any,
  items: any,
  setItems: (items: any) => void,
  mode: TraceAnalyticsMode,
  maxTraces: number = 500,
  dataSourceMDSId?: string,
  sort?: PropertySort,
  isUnderOneHour?: boolean,
  setUniqueTraces?: (count: number) => void
) => {
  const binarySearch = (arr: number[], target: number) => {
    if (!arr) return Number.NaN;
    let low = 0;
    let high = arr.length;
    let mid;
    while (low < high) {
      mid = Math.floor((low + high) / 2);
      if (arr[mid] < target) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, Math.min(100, low));
  };

  const responsePromise = handleDslRequest(
    http,
    DSL,
    getTracesQuery(mode, undefined, maxTraces, sort, isUnderOneHour),
    mode,
    dataSourceMDSId
  );

  // percentile should only be affected by timefilter
  const percentileRangesPromise =
    mode === 'data_prepper' || mode === 'custom_data_prepper'
      ? handleDslRequest(
          http,
          timeFilterDSL,
          getTraceGroupPercentilesQuery(),
          mode,
          dataSourceMDSId
        ).then((response) => {
          const map: Record<string, number[]> = {};
          response.aggregations.trace_group_name.buckets.forEach((traceGroup: any) => {
            map[traceGroup.key] = Object.values(traceGroup.percentiles.values).map((value: any) =>
              nanoToMilliSec(value)
            );
          });
          return map;
        })
      : Promise.resolve({});

  const promises = [responsePromise, percentileRangesPromise];

  return Promise.allSettled(promises)
    .then(([responseResult, percentileRangesResult]) => {
      if (responseResult.status === 'rejected') {
        setItems([]);
        return;
      }

      const percentileRanges =
        percentileRangesResult.status === 'fulfilled' ? percentileRangesResult.value : {};
      const response = responseResult.value;

      if (setUniqueTraces) {
        const uniqueTraces = response?.aggregations?.unique_traces?.value ?? 0;
        setUniqueTraces(uniqueTraces);
      }

      if (
        !response?.aggregations?.traces?.buckets ||
        response.aggregations.traces.buckets.length === 0
      ) {
        setItems([]);
        return;
      }

      const newItems = response.aggregations.traces.buckets.map((bucket: any) => {
        if (mode === 'data_prepper' || mode === 'custom_data_prepper') {
          return {
            trace_id: bucket.key,
            trace_group: bucket.trace_group.buckets[0]?.key,
            latency: bucket.latency.value,
            last_updated: moment(bucket.last_updated.value).format(TRACE_ANALYTICS_DATE_FORMAT),
            error_count: bucket.error_count.doc_count,
            percentile_in_trace_group: binarySearch(
              percentileRanges[bucket.trace_group.buckets[0]?.key],
              bucket.latency.value
            ),
            actions: '#',
          };
        }
        return {
          trace_id: bucket.key,
          latency: bucket.latency.value,
          last_updated: moment(bucket.last_updated.value).format(TRACE_ANALYTICS_DATE_FORMAT),
          error_count: bucket.error_count.doc_count,
          actions: '#',
        };
      });
      setItems(newItems);
    })
    .catch((error) => {
      console.error('Error in handleTracesRequest:', error);
      coreRefs.core?.notifications.toasts.addError(error, {
        title: 'Failed to retrieve traces',
        toastLifeTimeMs: 10000,
      });
    });
};

export const handleSpansFlyoutRequest = (
  http: HttpSetup,
  spanId: string,
  setItems: (items: any) => void,
  mode: TraceAnalyticsMode,
  dataSourceMDSId?: string
) => {
  return handleDslRequest(http, null, getSpanFlyoutQuery(mode, spanId), mode, dataSourceMDSId)
    .then((response) => {
      setItems(response?.hits.hits?.[0]?._source);
    })
    .catch((error) => {
      console.error('Error in handleSpansFlyoutRequest:', error);
      coreRefs.core?.notifications.toasts.addError(error, {
        title: `Failed to retrieve span details for span ID: ${spanId}`,
        toastLifeTimeMs: 10000,
      });
    });
};

export const parseSpanHitData = (span: ParsedHit, mode: TraceAnalyticsMode) => {
  const spanId = mode === 'jaeger' ? get(span._source, ['spanID']) : get(span._source, ['spanId']);
  const durationInMs =
    mode === 'jaeger'
      ? round(microToMilliSec(get(span._source, ['duration'])), 2)
      : round(nanoToMilliSec(get(span._source, ['durationInNanos'])), 2);
  const serviceName =
    mode === 'jaeger'
      ? get(span._source, ['process']).serviceName
      : get(span._source, ['serviceName']);
  const name =
    mode === 'jaeger' ? get(span._source, ['operationName']) : get(span._source, ['name']);
  const error =
    mode === 'jaeger'
      ? get(span._source, ['tag'])?.['error'] === true
        ? ' \u26a0 Error'
        : ''
      : get(span._source, ['status.code']) === 2
      ? ' \u26a0 Error'
      : '';
  return { spanId, durationInMs, serviceName, name, error };
};

interface Hit {
  _index: string;
  _id: string;
  _score: number;
  _source: any;
  sort?: any[];
}

interface ParsedResponse {
  hits?: {
    hits: Hit[];
  };
  [key: string]: any;
}

export function normalizePayload(parsed: ParsedResponse): Hit[] {
  if (parsed.hits && Array.isArray(parsed.hits.hits)) {
    return parsed.hits.hits;
  }
  return [];
}

const getStartTimeInNanos = (hit: ParsedHit, mode: TraceAnalyticsMode) => {
  return mode === 'jaeger'
    ? Number(hit._source.startTime) * 1000 // jaeger uses microseconds
    : parseIsoToNano(hit._source.startTime);
};

export const handlePayloadRequest = (
  traceId: string,
  http: HttpSetup,
  spanDSL: any,
  setPayloadData: (payloadData: any) => void,
  mode: TraceAnalyticsMode,
  dataSourceMDSId?: string
) => {
  return handleDslRequest(http, spanDSL, getPayloadQuery(mode, traceId), mode, dataSourceMDSId)
    .then((response) => {
      const normalizedData = normalizePayload(response);
      const sortedData = normalizedData
        .map((hit) => {
          const time = getStartTimeInNanos(hit, mode);

          return {
            ...hit,
            sort: hit.sort && hit.sort[0] ? hit.sort : [time],
          };
        })
        .sort((a, b) => b.sort[0] - a.sort[0]); // Sort in descending order by the sort field

      setPayloadData(JSON.stringify(sortedData, null, 2));
    })
    .catch((error) => {
      console.error('Error in handlePayloadRequest:', error);
    });
};

export const handleSpansRequest = (
  http: HttpSetup,
  setItems: (items: any) => void,
  setTotal: (total: number) => void,
  spanSearchParams: SpanSearchParams,
  DSL: any,
  mode: TraceAnalyticsMode,
  dataSourceMDSId?: string
) => {
  return handleDslRequest(http, DSL, getSpansQuery(spanSearchParams), mode, dataSourceMDSId)
    .then((response) => {
      setItems(response.hits.hits.map((hit: any) => hit._source));
      setTotal(response.hits.total?.value || 0);
    })
    .catch((error) => {
      console.error('Error in handleSpansRequest:', error);
      coreRefs.core?.notifications.toasts.addError(error, {
        title: 'Failed to retrieve spans',
        toastLifeTimeMs: 10000,
      });
    });
};

type SpanMap = Record<string, HierarchicalSpan>;

type SpanReference = {
  refType: 'CHILD_OF' | 'FOLLOWS_FROM';
  spanID: string;
};

const addRootSpan = (
  spanId: string,
  spanMap: SpanMap,
  rootSpans: HierarchicalSpan[],
  alreadyAddedRootSpans: Set<string>
) => {
  if (!alreadyAddedRootSpans.has(spanId)) {
    rootSpans.push(spanMap[spanId]);
    alreadyAddedRootSpans.add(spanId);
  }
};

export const hitsToHierarchicalSpans = (hits: ParsedHit[], mode: TraceAnalyticsMode) => {
  const spanMap: SpanMap = {};
  hits.forEach((hit) => {
    const spanIdKey = mode === 'jaeger' ? 'spanID' : 'spanId';
    spanMap[(hit._source as Span & { spanID: string })[spanIdKey]] = {
      hit,
      startTimeInNanos: getStartTimeInNanos(hit, mode),
      children: [],
    };
  });

  const rootSpans: HierarchicalSpan[] = [];
  const alreadyAddedRootSpans: Set<string> = new Set(); // Track added root spans

  hits.forEach((hit) => {
    if (mode === 'jaeger') {
      const spanIdKey = 'spanID';
      const source = hit._source as Span & { spanID: string; references: SpanReference[] };
      const references: SpanReference[] = source.references || [];
      references.forEach((ref: SpanReference) => {
        if (ref.refType === 'CHILD_OF') {
          const parentSpan = spanMap[ref.spanID];
          if (parentSpan) {
            if (!parentSpan.children) {
              parentSpan.children = [];
            }
            parentSpan.children.push(spanMap[source[spanIdKey]]);
          }
        }

        if (ref.refType === 'FOLLOWS_FROM' && !alreadyAddedRootSpans.has(source[spanIdKey])) {
          addRootSpan(source[spanIdKey], spanMap, rootSpans, alreadyAddedRootSpans);
        }
      });

      if (references.length === 0 || references.every((ref) => ref.refType === 'FOLLOWS_FROM')) {
        addRootSpan(source[spanIdKey], spanMap, rootSpans, alreadyAddedRootSpans);
      }
    } else {
      // Data Prepper
      const spanIdKey = 'spanId';
      const source = hit._source;
      if (source.parentSpanId && spanMap[source.parentSpanId]) {
        const parentSpan = spanMap[source.parentSpanId];
        if (!parentSpan.children) {
          parentSpan.children = [];
        }
        if (spanMap[source[spanIdKey]]) {
          parentSpan.children.push(spanMap[source[spanIdKey]]);
        }
      } else {
        if (source[spanIdKey] && spanMap[source[spanIdKey]]) {
          addRootSpan(source[spanIdKey], spanMap, rootSpans, alreadyAddedRootSpans);
        }
      }
    }
  });

  return rootSpans;
};

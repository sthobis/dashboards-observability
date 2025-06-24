/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable react-hooks/exhaustive-deps */

import {
  EuiBadge,
  EuiButtonGroup,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHorizontalRule,
  EuiLoadingChart,
  EuiPanel,
  EuiSmallButton,
  EuiSpacer,
} from '@elastic/eui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useObservable from 'react-use/lib/useObservable';
import type PlotlyType from 'plotly.js';
import { get } from 'lodash';
import { HttpSetup } from '../../../../../../../src/core/public';
import { TraceAnalyticsMode } from '../../../../../common/types/trace_analytics';
import { BarOrientation } from '../../../../../common/constants/shared';
import { coreRefs } from '../../../../framework/core_refs';
import { Plt } from '../../../visualizations/plotly/plot';
import { hitsToHierarchicalSpans, parseSpanHitData } from '../../requests/traces_request_handler';
import { HierarchicalSpan, TRACE_CHART_ROW_HEIGHT, TraceFilter } from '../common/constants';
import { nanoToMilliSec, PanelTitle, parseHits } from '../common/helper_functions';
import { SpanDetailFlyout } from './span_detail_flyout';
import { SpanDetailTable, SpanDetailTableHierarchy } from './span_detail_table';

interface SpanDetailPanelProps {
  http: HttpSetup;
  traceId: string;
  colorMap: any;
  mode: TraceAnalyticsMode;
  dataSourceMDSId: string;
  dataSourceMDSLabel: string | undefined;
  spanFilters: TraceFilter[];
  setSpanFiltersWithStorage: (newFilters: TraceFilter[]) => void;
  page?: string;
  openSpanFlyout?: any;
  isApplicationFlyout?: boolean;
  payloadData: string;
  isGanttChartLoading?: boolean;
  setGanttChartLoading?: (loading: boolean) => void;
}

export function SpanDetailPanel(props: SpanDetailPanelProps) {
  const { chrome } = coreRefs;
  const { mode } = props;
  const fromApp = props.page === 'app';

  const [data, setData] = useState<{
    gantt: PlotlyType.PlotData[];
    ganttAnnotations: Partial<PlotlyType.Annotations>[];
    ganttMax: number;
  }>({
    gantt: [],
    ganttAnnotations: [],
    ganttMax: 0,
  });
  const fullRange: [number, number] = [0, data.ganttMax * 1.1];
  const [selectedRange, setSelectedRange] = useState<[number, number]>([0, 0]);
  const isLocked = useObservable(chrome!.getIsNavDrawerLocked$() ?? false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState<number>(window.innerWidth);
  const newNavigation = coreRefs?.chrome?.navGroup.getNavGroupEnabled?.();

  const updateAvailableWidth = () => {
    if (containerRef.current) {
      setAvailableWidth(containerRef.current.getBoundingClientRect().width);
    } else {
      setAvailableWidth(window.innerWidth);
    }
  };

  const handleFullScreenChange = () => {
    const isFullscreenActive = !!document.fullscreenElement;
    setIsFullScreen(isFullscreenActive);
    updateAvailableWidth();
  };

  useEffect(() => {
    // Add event listeners for window resize and full-screen toggling
    window.addEventListener('resize', updateAvailableWidth);
    document.addEventListener('fullscreenchange', handleFullScreenChange);

    // Initial update
    updateAvailableWidth();

    return () => {
      // Clean up event listeners
      window.removeEventListener('resize', updateAvailableWidth);
      document.removeEventListener('fullscreenchange', handleFullScreenChange);
    };
  }, []);

  const dynamicLayoutAdjustment = useMemo(() => {
    const adjustment = newNavigation ? 350 : 400; // allows resizing of the window
    const leftNavAdjustment = newNavigation ? 125 : 75;
    return isLocked ? availableWidth - adjustment : availableWidth - leftNavAdjustment;
  }, [isLocked, availableWidth]);

  const addSpanFilter = (field: string, value: any) => {
    const newFilters = [...props.spanFilters];
    const index = newFilters.findIndex(({ field: filterField }) => field === filterField);
    if (index === -1) {
      newFilters.push({ field, value });
    } else {
      newFilters.splice(index, 1, { field, value });
    }
    props.setSpanFiltersWithStorage(newFilters);
  };

  const removeSpanFilter = (field: string) => {
    const newFilters = [...props.spanFilters];
    const index = newFilters.findIndex(({ field: filterField }) => field === filterField);
    if (index !== -1) {
      newFilters.splice(index, 1);
      props.setSpanFiltersWithStorage(newFilters);
    }
  };

  useEffect(() => {
    if (!props.payloadData) {
      props.setGanttChartLoading?.(false);
      return;
    }

    const hits = parseHits(props.payloadData);
    const hierarchicalSpans = hitsToHierarchicalSpans(hits, mode);
    const startTimeInMs = Math.min(
      ...hierarchicalSpans.map((span) => nanoToMilliSec(span.startTimeInNanos))
    );

    const { data, annotations, maxX } = createPlotlyData(
      hierarchicalSpans,
      mode,
      props.colorMap,
      startTimeInMs
    );

    setData({ gantt: data, ganttAnnotations: annotations, ganttMax: maxX });
    // Update selectedRange whenever data changes to ensure it starts fully zoomed out
    setSelectedRange([0, maxX * 1.1]);

    props.setGanttChartLoading?.(false);
  }, [props.payloadData, mode, props.colorMap]);

  const layout: Partial<PlotlyType.Layout> = useMemo(() => {
    // get unique labels from traces
    const yLabels = data.gantt.map((d) => d.y[0]);
    const topMargin = 20;

    return {
      height: TRACE_CHART_ROW_HEIGHT * data.gantt.length + topMargin,
      width: props.isApplicationFlyout
        ? availableWidth / 2 - 100 // Allow gantt chart to fit in flyout
        : availableWidth, // Allow gantt chart to render full screen
      margin: {
        l: 2,
        r: 2,
        b: 2,
        t: topMargin,
      },
      xaxis: {
        ticksuffix: ' ms',
        side: 'top' as const,
        color: '#5e6d82',
        showgrid: true,
        gridcolor: 'rgba(226, 232, 240, 0.5)',
        showline: false,
        zeroline: false,
        range: selectedRange, // Apply selected range to the x-axis
      },
      yaxis: {
        visible: false,
        tickvals: yLabels,
        fixedrange: true,
        autorange: 'reversed',
      },
      annotations: data.ganttAnnotations.map((annotation, i) => {
        // Adjust annotation (trace name) position to stay within the visible range when zoomed
        // If annotation starts before the visible range but the span extends into it,
        // move the annotation to the start of the visible range
        let normalizedX = annotation.x as number;
        if (
          normalizedX < selectedRange[0] &&
          annotation.y === data.gantt[i].y[0] &&
          ((data.gantt[i] as any).base as number) + (data.gantt[i].x[0] as number) >
            selectedRange[0]
        ) {
          normalizedX = selectedRange[0];
        }
        return {
          ...annotation,
          x: normalizedX,
        };
      }),
      shapes: [
        {
          // grid border
          type: 'rect',
          xref: 'paper',
          yref: 'paper',
          x0: 0,
          x1: 1,
          y0: 0,
          y1: 1,
          line: {
            color: 'rgba(226, 232, 240, 1)',
            width: 1,
          },
          fillcolor: 'rgba(0,0,0,0)',
        },
      ],
    };
  }, [data.gantt, data.ganttAnnotations, selectedRange, availableWidth, isLocked, isFullScreen]);
  const miniMapLayout: Partial<PlotlyType.Layout> = {
    width: layout.width,
    height: 80,
    margin: layout.margin,
    dragmode: 'select',
    selectdirection: 'h',
    xaxis: {
      ticksuffix: ' ms',
      side: 'top' as const,
      color: '#5e6d82',
      showgrid: true,
      gridcolor: 'rgba(226, 232, 240, 0.5)',
      range: [fullRange[0], fullRange[1]],
      showline: false,
      zeroline: false,
      fixedrange: true,
    },
    yaxis: { visible: false, fixedrange: true, autorange: 'reversed' },
    shapes: [
      {
        // grid border
        type: 'rect',
        xref: 'paper',
        yref: 'paper',
        x0: 0,
        x1: 1,
        y0: 0,
        y1: 1,
        fillcolor: 'rgba(0,0,0,0)',
        line: {
          color: 'rgba(226, 232, 240, 1)',
          width: 1,
        },
      },
      {
        // range highlight box
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0: selectedRange[0],
        x1: selectedRange[1],
        y0: 0,
        y1: 1,
        fillcolor: 'rgba(0, 120, 212, 0.1)',
        line: {
          width: 1,
          color: 'rgba(0, 120, 212, 0.2)',
        },
      },
    ],
  };

  const [currentSpan, setCurrentSpan] = useState('');

  const renderFilters = useMemo(() => {
    return props.spanFilters.map(({ field, value }) => (
      <EuiFlexItem grow={false} key={`span-filter-badge-${field}`}>
        <EuiBadge
          iconType="cross"
          iconSide="right"
          iconOnClick={() => removeSpanFilter(field)}
          iconOnClickAriaLabel="remove current filter"
        >
          {`${field}: ${value}`}
        </EuiBadge>
      </EuiFlexItem>
    ));
  }, [props.spanFilters]);

  const onClick = useCallback(
    (event: any) => {
      console.log('onClick', event);
      if (!event?.points) return;
      const point = event.points[0];
      if (fromApp) {
        props.openSpanFlyout(point.data.spanId);
      } else {
        setCurrentSpan(point.data.spanId);
      }
    },
    [props.openSpanFlyout, setCurrentSpan, fromApp]
  );

  const onRelayoutHandler = useCallback(
    (event: PlotlyType.PlotSelectionEvent) => {
      const x0 = get(event, 'xaxis.range[0]', null) || get(event, 'selections[0].x0', null);
      const x1 = get(event, 'xaxis.range[1]', null) || get(event, 'selections[0].x1', null);
      if (x0 && x1) {
        // Update selected range when the shape (rectangle) is moved
        setSelectedRange([x0, x1]);
      } else {
        setSelectedRange(fullRange);
      }
    },
    [setSelectedRange, fullRange]
  );

  const toggleOptions = [
    {
      id: 'timeline',
      label: 'Timeline',
    },
    {
      id: 'span_list',
      label: 'Span list',
    },
    {
      id: 'hierarchy_span_list',
      label: 'Tree view',
    },
  ];
  const [toggleIdSelected, setToggleIdSelected] = useState(toggleOptions[0].id);

  const spanDetailTable = useMemo(
    () => (
      <div style={{ width: 'auto' }}>
        <SpanDetailTable
          http={props.http}
          hiddenColumns={mode === 'jaeger' ? ['traceID', 'traceGroup'] : ['traceId', 'traceGroup']}
          mode={mode}
          openFlyout={(spanId: string) => {
            if (fromApp) {
              props.openSpanFlyout(spanId);
            } else {
              setCurrentSpan(spanId);
            }
          }}
          dataSourceMDSId={props.dataSourceMDSId}
          availableWidth={dynamicLayoutAdjustment}
          payloadData={props.payloadData}
          filters={props.spanFilters}
        />
      </div>
    ),
    [setCurrentSpan, dynamicLayoutAdjustment, props.payloadData, props.spanFilters]
  );

  const spanDetailTableHierarchy = useMemo(
    () => (
      <div style={{ width: 'auto' }}>
        <SpanDetailTableHierarchy
          http={props.http}
          hiddenColumns={mode === 'jaeger' ? ['traceID', 'traceGroup'] : ['traceId', 'traceGroup']}
          mode={mode}
          openFlyout={(spanId: string) => {
            if (fromApp) {
              props.openSpanFlyout(spanId);
            } else {
              setCurrentSpan(spanId);
            }
          }}
          dataSourceMDSId={props.dataSourceMDSId}
          availableWidth={dynamicLayoutAdjustment}
          payloadData={props.payloadData}
          filters={props.spanFilters}
        />
      </div>
    ),
    [setCurrentSpan, dynamicLayoutAdjustment, props.payloadData, props.spanFilters]
  );

  const miniMap = useMemo(
    () => (
      <Plt
        data={data.gantt}
        config={{
          editable: false,
          doubleClick: 'reset',
        }}
        layout={miniMapLayout}
        onRelayout={onRelayoutHandler}
      />
    ),
    [data.gantt, miniMapLayout, setSelectedRange]
  );

  const ganttChartRef = useRef<HTMLDivElement>(null);
  const ganttChart = useMemo(
    () => (
      <Plt
        ref={ganttChartRef}
        data={data.gantt}
        layout={layout}
        onClickHandler={onClick}
        onHoverHandler={onHover}
        onUnhoverHandler={onUnhover}
        onRelayout={onRelayoutHandler}
      />
    ),
    [data.gantt, layout]
  );

  return (
    <>
      <EuiPanel data-test-subj="span-gantt-chart-panel">
        <EuiFlexGroup direction="column" gutterSize="m">
          <EuiFlexItem grow={false}>
            <EuiFlexGroup>
              <EuiFlexItem>
                <PanelTitle title="Spans" totalItems={data.gantt.length / 2} />
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiFlexGroup justifyContent="flexEnd" alignItems="center" gutterSize="s">
                  {toggleIdSelected === 'timeline' && (
                    <EuiFlexItem grow={false}>
                      <EuiSmallButton
                        onClick={() => setSelectedRange(fullRange)}
                        isDisabled={
                          selectedRange[0] === fullRange[0] && selectedRange[1] === fullRange[1]
                        }
                      >
                        Reset zoom
                      </EuiSmallButton>
                    </EuiFlexItem>
                  )}
                  <EuiFlexItem grow={false}>
                    <EuiButtonGroup
                      isDisabled={props.isGanttChartLoading}
                      legend="Select view of spans"
                      options={toggleOptions}
                      idSelected={toggleIdSelected}
                      onChange={(id) => setToggleIdSelected(id)}
                    />
                  </EuiFlexItem>
                </EuiFlexGroup>
              </EuiFlexItem>
            </EuiFlexGroup>
          </EuiFlexItem>
          {props.isGanttChartLoading ? (
            <div className="center-loading-div">
              <EuiLoadingChart size="l" />
            </div>
          ) : (
            <>
              {props.spanFilters.length > 0 && (
                <EuiFlexItem grow={false}>
                  <EuiSpacer size="s" />
                  <EuiFlexGroup gutterSize="s" wrap>
                    {renderFilters}
                  </EuiFlexGroup>
                </EuiFlexItem>
              )}

              <EuiHorizontalRule margin="m" />

              {toggleIdSelected === 'timeline' && <EuiFlexItem grow={false}>{miniMap}</EuiFlexItem>}

              <EuiFlexItem style={{ overflowY: 'auto', maxHeight: 400 }}>
                <div ref={containerRef}>
                  {toggleIdSelected === 'timeline'
                    ? ganttChart
                    : toggleIdSelected === 'span_list'
                    ? spanDetailTable
                    : spanDetailTableHierarchy}
                </div>
              </EuiFlexItem>
            </>
          )}
        </EuiFlexGroup>
      </EuiPanel>
      {!!currentSpan && (
        <SpanDetailFlyout
          http={props.http}
          spanId={currentSpan}
          isFlyoutVisible={!!currentSpan}
          closeFlyout={() => setCurrentSpan('')}
          addSpanFilter={addSpanFilter}
          mode={mode}
          dataSourceMDSId={props.dataSourceMDSId}
          dataSourceMDSLabel={props.dataSourceMDSLabel}
        />
      )}
    </>
  );
}

const setCursor = (target: HTMLElement, cursor: string) => {
  const container = (target as HTMLElement).closest('.js-plotly-plot');
  const dragLayerElements = container?.getElementsByClassName('nsewdrag');
  if (!dragLayerElements || dragLayerElements.length === 0) return;
  const dragLayer = dragLayerElements[0] as HTMLElement;
  if (dragLayer) {
    dragLayer.style.cursor = cursor;
  }
};

const onHover = (e: PlotlyType.PlotMouseEvent) => {
  const target = e.event.target;
  if (!target) return;
  setCursor(target as HTMLElement, 'pointer');
};

const onUnhover = (e: PlotlyType.PlotMouseEvent) => {
  const target = e.event.target;
  if (!target) return;
  setCursor(target as HTMLElement, '');
};

const createPlotlyData = (
  spans: HierarchicalSpan[],
  mode: TraceAnalyticsMode,
  colorMap: Record<string, string>,
  startTimeInMs: number
) => {
  const data: PlotlyType.PlotData[] = [];
  const annotations: Partial<PlotlyType.Annotations>[] = [];
  let maxX = 0;

  const processSpan = (span: HierarchicalSpan) => {
    const delayInMs = nanoToMilliSec(span.startTimeInNanos) - startTimeInMs;

    const { spanId, durationInMs, serviceName, name, error } = parseSpanHitData(span.hit, mode);
    maxX = Math.max(maxX, delayInMs + durationInMs);

    const spanBar: PlotlyType.PlotData = {
      x: [durationInMs],
      y: [spanId],
      name: '',
      customdata: [spanId, durationInMs, delayInMs],
      marker: {
        color: colorMap[serviceName],
      },
      width: 0.4,
      // @ts-ignore plotly outdated type?? https://plotly.com/javascript/reference/bar/#bar-base
      base: delayInMs,
      type: 'bar',
      orientation: BarOrientation.horizontal,
      spanId,
      hoverinfo: 'none',
    };
    data.push(spanBar);

    const spanBarLabel: Partial<PlotlyType.Annotations> = {
      x: delayInMs,
      y: spanId,
      text: `${
        error ? `<span style="color: red;">${error}</span>&nbsp;&nbsp;` : ''
      }${serviceName}: ${name} - ${durationInMs.toFixed(2)}ms`,
      align: 'left',
      showarrow: false,
      xanchor: 'left',
      valign: 'bottom',
      height: TRACE_CHART_ROW_HEIGHT,
      yshift: 0,
      bgcolor: 'rgba(255,0,0,0)',
      borderpad: 0,
      borderwidth: 0,
    };
    annotations.push(spanBarLabel);

    // recursively process children
    span.children.sort((a, b) => a.startTimeInNanos - b.startTimeInNanos).forEach(processSpan);
  };

  spans.sort((a, b) => a.startTimeInNanos - b.startTimeInNanos).forEach(processSpan);
  return { data, annotations, maxX };
};

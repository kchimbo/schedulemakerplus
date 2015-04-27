function getProfessorKey(professorFullName) {
  return professorFullName.toLowerCase()
}

function startsWith(targetString, inputString) {
  return targetString.indexOf(inputString) === 0
}

var Completion = {
  RETRIEVING: 0,
  SUMMARY: 1,
  REVIEWS: 2,
  NOT_AVAILABLE: 3
}


var professor = (function() {

  function identity(input) { return input }

  function docConfig(xhr) { xhr.responseType = 'document' }

  function xhr2Extract(xhr) { return xhr.response }

  function buildDocRequest(url) {
    return m.request({
      method: 'GET',
      url: url,
      config: docConfig,
      deserialize: identity,
      extract: xhr2Extract
    })
  }

  function isBlacklistedName(fullName) {
    return fullName.indexOf('Determined') > -1 || fullName.indexOf('TBD') > -1
  }

  function err(reason) { console.info('error', reason) }

  var cache = {}

  function Professor(fullName) {

    this.key = getProfessorKey(fullName)

    this.fullName = fullName

    this.schoolName = null

    this.siteId = null

    this.ratingSummary = {}

    this.reviews = []

    this.tags = []

    this.completion = Completion.RETRIEVING

    this.addReview = function(obj) {
      this.reviews.push(obj)
    }

    this.addTag = function(tagName) {
      var idx = -1
      for (var i=0, len=this.tags.length; i<len; i++) {
        if (this.tags[i].name == tagName) {
          this.tags[i].count = this.tags[i].count + 1
          idx = i
          break;
        }
      }

      if (idx == -1) {
        this.tags.push({name: tagName, count: 1})
      }
    }

  }

  var Retrieval = function() {

    var siteId = null

    var schoolName = null

    function getProfessor(fullName) {
      return cache[getProfessorKey(fullName)] || null
    }

    function saveProfessor(professor) {
      cache[getProfessorKey(professor.fullName)] = professor
    }

    function publishProfessorChange(professor) {
      PubSub.publish(professor.key, professor)
    }

    this.grab = function(fullName) {

      var professor = getProfessor(fullName)

      if (!professor) {
        professor = new Professor(fullName)
        saveProfessor(professor)

        retrieveSummaryFromWeb(fullName)

            .then(function(summary) {
              professor.ratingSummary = summary
              professor.siteId = siteId
              professor.schoolName = schoolName
              professor.completion = Completion.SUMMARY
              saveProfessor(professor)
              publishProfessorChange(professor)
              return professor
            })

            .then(retrieveReviewsFromWeb)

            .then(function(reviews) {
              reviews.forEach(function(obj) {
                obj['ratings'].forEach(function(review) {
                  professor.addReview.call(professor, review)
                  review['teacherRatingTags'].forEach(
                      professor.addTag.bind(professor))
                })
              })

              professor.completion = Completion.REVIEWS
              saveProfessor(professor)
              publishProfessorChange(professor)
              return professor
            })
            .then(null, function(err) {
              professor.completion = Completion.NOT_AVAILABLE
              saveProfessor(professor)
              publishProfessorChange(professor)
            })

      } else {
        publishProfessorChange(professor)
      }

    }

    function retrieveSummaryFromWeb(professorFullName) {
      return getSearchPageForProfessor(professorFullName)
          .then(extractFirstSearchPageMatch)
          .then(getRatingsSummaryPage)
          .then(extractRatingsSummary)
    }

    function getSearchPageForProfessor(professorFullName) {
      var searchUrl = 'http://www.ratemyprofessors.com/search.jsp?queryBy=teacherName&queryoption=HEADER&query=' +
          encodeURIComponent(professorFullName) +
          '&facetSearch=true&schoolName=rochester+institute+of+technology'
      return buildDocRequest(searchUrl)
    }

    function extractFirstSearchPageMatch(doc) {
      return new Promise(function (resolve, reject) {

        var subinfo = doc.querySelector('#searchResultsBox span.sub')
        if (subinfo) {
          schoolName = subinfo.textContent
        }

        var link = doc.querySelector('li.listing.PROFESSOR a')

        if (link) {
          var matches = /tid=(\d+)$/.exec(link.href)
          if (matches) {
            resolve(matches[1])
          }
          else {
            reject('Could not extract professor site ID')
          }
        } else {
          reject('No matches')
        }
      })
    }

    function getRatingsSummaryPage(professorSiteId) {
      siteId = professorSiteId
      var url = 'http://www.ratemyprofessors.com/ShowRatings.jsp?tid=' +
          professorSiteId
      return buildDocRequest(url)
    }

    function extractRatingsSummary(doc) {

      function extractNumericRating(el) {
        return Number(el.querySelector('.rating').textContent)
      }

      return new Promise(function(resolve, reject) {
        if (doc) {
          var els = doc.querySelectorAll(
              '.rating-breakdown .left-breakdown .rating-slider')
          if (els && els.length === 6) {
            els = [].slice.call(els)
            els.splice(3)
            resolve({
              helpfulness: extractNumericRating(els[0]),
              clarity: extractNumericRating(els[1]),
              easiness: extractNumericRating(els[2])
            })
          } else {
            reject('Couldn\'t find rating sliders')
          }
        } else {
          reject('No document to analyze')
        }
      })
    }


    function retrieveReviewsFromWeb() {
      return getReviewPage(siteId, 1)
          .then(grabReviews)
    }

    function getReviewPage(siteId, page) {
      return m.request({
        method: 'GET',
        url: 'http://www.ratemyprofessors.com/paginate/professors/ratings?tid=' +
        siteId + '&page=' + page
      })
    }

    function grabReviews(json) {
      var totalPages = Math.ceil((json['remaining'] + 12) / 12)
      var deferreds = []
      for (var i = 1, len = totalPages; i <= len; i++) {
        deferreds.push(getReviewPage(siteId, i))
      }
      return m.sync(deferreds)
    }

  }


  return {
    Retrieval: Retrieval,
    isBlacklistedName: isBlacklistedName
  }

})()

var Ratings = function(fullName) {

  function average(values) {
    return values.reduce(function(prev, curr) { return prev + curr }, 0) /
        values.length
  }

  function sd(values) {
    var avg = average(values)
    var diffs = values.map(function(val) { return val - avg })
    var sqDiffs = diffs.map(function(diff) { return diff * diff })
    var avgSqDiffs = average(sqDiffs)
    return Math.sqrt(avgSqDiffs)
  }

  function roundOneDecimal(n) {
    return Math.round(n * 10) / 10
  }

  function controller() {

    this.professor = m.prop(null)

    this.retrieval = new professor.Retrieval()

    this.completion = m.prop(Completion.RETRIEVING)

    var tableData = null

    this.getTableData = function() {
      if (tableData != null) return tableData

      var helpfulness = [], clarity = [], easiness = []
      var reviews = this.professor().reviews
      reviews.forEach(function(review) {
        helpfulness.push(review['rHelpful'])
        clarity.push(review['rClarity'])
        easiness.push(review['rEasy'])
      })

      tableData = {
        helpfulness: {
          score: roundOneDecimal(average(helpfulness)),
          sd: roundOneDecimal(sd(helpfulness))
        },
        clarity: {
          score: roundOneDecimal(average(clarity)),
          sd: roundOneDecimal(sd(clarity))
        },
        easiness: {
          score: roundOneDecimal(average(easiness)),
          sd: roundOneDecimal(sd(easiness))
        },
        totalReviews: reviews.length
      }

      return tableData
    }

    var tagsData = null

    this.getTagsData = function() {
      if (tagsData != null) return tagsData

      tagsData = this.professor().tags
      tagsData.sort(function(a, b) {
        if (a.count > b.count) return -1
        if (a.count < b.count) return 1
        return 0
      })

      return tagsData
    }


    this.gotProfessor = function(key, prof) {
      this.completion(prof.completion)
      this.professor(prof)
      m.redraw()
    }

    this.shouldShowDetails = m.prop(false)

    this.toggleDetails = function() {

      if (this.shouldShowDetails()) {
        this.shouldShowDetails(false)
      } else {
        this.shouldShowDetails(true)
      }
    }

    this.shouldShowTags = m.prop(false)

    this.showTags = function() {
      this.shouldShowTags(true)
    }

    if (professor.isBlacklistedName(fullName)) {
      this.completion(Completion.NOT_AVAILABLE)
    }
    else {
      PubSub.subscribe(getProfessorKey(fullName),
          this.gotProfessor.bind(this))

      this.retrieval.grab(fullName)
    }

  }

  function view(ctrl) {

    function getSlider(value, label) {
      return m('label', [
          m('input', {
            type: 'range',
            min: 0.0,
            max: 5.0,
            step: 0.1,
            value: value,
            disabled: 'disabled'
          }),
          ' ' + label
      ])
    }

    function getSummaryTitleAttr(ratings) {
      return 'Helpfulness: ' + ratings.helpfulness + '\n' +
          'Clarity: ' + ratings.clarity + '\n' +
          'Easiness: ' + ratings.easiness
    }

    function summaryRatings(ratings) {
      return m('div.smrate-inset-summary-ratings', {
        title: getSummaryTitleAttr(ratings)
      }, [
        getSlider(ratings.helpfulness, 'Helpfulness'), m('br'),
        getSlider(ratings.clarity, 'Clarity'), m('br'),
        getSlider(ratings.easiness, 'Easiness')
      ])
    }

    function summaryButtons() {
      var hasReviews = ctrl.completion() === Completion.REVIEWS
      return m('div.smrate-inset-summary-buttons', [
        m('button', {
          disabled: !hasReviews,
          onclick: function() {
            PubSub.publish('viewProf', ctrl.professor())
          }
        }, 'Reviews ⋮'),
        m('button', {
          disabled: !hasReviews,
          onclick: ctrl.toggleDetails.bind(ctrl)
        }, 'Details')
      ])
    }

    function table(ctrl) {
      var tableData = ctrl.getTableData()
      var totalReviews = tableData.totalReviews
      var totalReviewsText = 'based on ' + totalReviews + ' review' +
          (totalReviews > 1 ? 's' : '')
      return m('.smrate-inset-table-inner', [
            m('table', [
              m('thead', [
                m('tr', [
                  m('td', 'Item'),
                  m('td.ccol', 'Score'),
                  m('td.ccol', {title: 'Standard deviation'}, 'SD')
                ])
              ]),
              m('tbody', [
                m('tr', [
                  m('td', 'Helpfulness'),
                  m('td.ccol.ncol', tableData.helpfulness.score),
                  m('td.ccol.ncol', tableData.helpfulness.sd)
                ]),
                m('tr', [
                  m('td', 'Clarity'),
                  m('td.ccol.ncol', tableData.clarity.score),
                  m('td.ccol.ncol', tableData.clarity.sd)
                ]),
                m('tr', [
                  m('td', 'Easiness'),
                  m('td.ccol.ncol', tableData.easiness.score),
                  m('td.ccol.ncol', tableData.easiness.sd)
                ])
              ])
            ]),
            m('p', totalReviewsText)
      ])
    }

    function tags(ctrl) {
      var tagsData = ctrl.getTagsData().slice(0, 5)
      var tagsDataTags = tagsData.map(function(tagData) {
        return m('div.smrate-tag', [
          m('span.smrate-tag-name', tagData.name),
          m('span.smrate-tag-count', tagData.count)
        ])
      })
      return tagsData.length == 0 ? null : [
        m('p', [
          'Top tags',
          m('span.smrate-tag-toggle', {
            style: ctrl.shouldShowTags() ? 'display:none; pointer-events: none' : 'display:inline',
            onclick: ctrl.showTags.bind(ctrl)
          }, '⋯')
        ]),
        ctrl.shouldShowTags() ? m('.smrate-tag-list', tagsDataTags) : null
      ]
    }

    function footer() {
      var fullName = ctrl.professor().fullName
      var schoolName = ctrl.professor().schoolName
      return m('div.smrate-inset-footer', [
          m('strong',
              fullName,
              schoolName ? ' – ' + schoolName : ''
          ),'.'
      ])
    }

    return m('div.smrate-inset',

      (function () {
        var completion = ctrl.completion()
        if (completion === Completion.RETRIEVING)
          return 'Retrieving ratings...'
        else if (completion === Completion.NOT_AVAILABLE)
          return 'Ratings not available.'
        else {
          return [
            m('div.smrate-inset-summary', [
              summaryRatings(ctrl.professor().ratingSummary),
              summaryButtons()
            ]),

            m('div.smrate-inset-table',
                ctrl.shouldShowDetails() ? table(ctrl) : null),

            m('div.smrate-inset-tags',
                ctrl.shouldShowDetails() ? tags(ctrl) : null),

            footer()
          ]
        }
      })()
    )
  }

  return {
    controller: controller,
    view: view
  }
}


var Reviews = function(professor) {

  function controller() {
    this.professor = m.prop(professor || null)

    this.onViewProf = function(_, prof) {
      this.professor(prof)
      m.redraw()
    }

    this.closePopup = function() {
      this.professor(null)
      m.redraw()
    }

    PubSub.subscribe('viewProf', this.onViewProf.bind(this))
  }

  function drawPopup(ctrl) {
    var professor = ctrl.professor()
    var reviews = ctrl.professor().reviews

    function processComment(s) {
      return s.replace(/&quot;/g, '"')
    }

    function ratingBlock(key, label, review) {
      return m('.smrate-rating', [
        m('.smrate-rating-label', label),
        m('.smrate-rating-value', review[key])
      ])
    }

    function tags(review) {
      var tags = review.teacherRatingTags
      return tags.length == 0 ? null : m('p', [
        m('span.clead', 'Tags: '), [
          tags.map(function(tag) {
            return m('span.rtag', tag)
          })
        ]
      ])
    }

    return m('.overlay.overlay-scale open', [
      m('button[type=button].overlay-close', {
        onclick: ctrl.closePopup.bind(ctrl)
      }, 'Close'),
      m('.smrate-overlay-content', [
        m('.header', [
          m('h1.profname', 'Listing ' + reviews.length +
          (reviews.length > 1 ? ' reviews' : ' review') + ' for ' + professor.fullName),
          m('h2.schoolname', professor.schoolName)
        ]),
        m('.main', [
          m('table', [
            reviews.map(function (review) {
              return m('tr', [
                m('td.rcol', {style: 'text-align: center'}, [
                    ratingBlock('rHelpful', 'helpfulness', review),
                    ratingBlock('rClarity', 'clarity', review),
                    ratingBlock('rEasy', 'easiness', review)
                ]),
                m('td.ccol', [
                  m('p', [
                    m('span.clead', 'Date: '),
                    review['rDate']
                  ]),
                  m('p', [
                    m('span.clead', 'Class taken: '),
                    review['rClass']
                  ]),
                  m('p', [
                    m('span.clead', 'Comments: '),
                    processComment(review['rComments'])
                  ]),
                  tags(review)
                ])
              ])
            })
          ])
        ])
      ])
    ])
  }

  function view(ctrl) {
    return !ctrl.professor() ? null : drawPopup(ctrl)
  }

  return {
    controller: controller,
    view: view
  }

}


var domIdIdx = 0
function getNextDomId() {
  return 'smrate-domid-' + ++domIdIdx
}

function renderRatingsContainer(containerNode) {
  var id = getNextDomId()
  var el = document.createElement('div')
  el.id = id
  containerNode.appendChild(el)
  return el
}

function professorLinkWasAdded(linkNode, containerNode) {
  var professorFullName = linkNode.textContent
  var ratingsContainer = renderRatingsContainer(containerNode)
  m.module(ratingsContainer, Ratings(professorFullName))
}

function attachMutationObserver() {
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      var addedNodes = mutation.addedNodes, addedNode
      for (var i=0, len=addedNodes.length; i<len; i++) {
        addedNode = addedNodes[i]
        if (addedNode.tagName === 'A' &&
            startsWith(addedNode.href, 'http://www.ratemyprofessors.com')) {
          var container = addedNode.closest('li.course-info')
          if (container) professorLinkWasAdded(addedNode, container)
        }
      }
    })
  })
  observer.observe(document.body, {childList: true, subtree: true})
}

function renderReviews() {
  var el = document.createElement('div')
  el.id = getNextDomId()
  document.body.appendChild(el)
  m.module(el, Reviews())
}

function init() {
    attachMutationObserver()
    renderReviews()
}

init()
